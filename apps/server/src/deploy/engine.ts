import { createHash } from "node:crypto";
import type { Config } from "@canvas-drop/shared";
import type { Canvas, DeploySource, Manifest, Version } from "@canvas-drop/shared/db";
import { looksLikeApiKey } from "../canvas/api-key.js";
import { collectGarbage } from "../canvas/blob-gc.js";
import { soleHtmlEntry } from "../canvas/manifest.js";
import { mimeFor } from "../canvas/mime.js";
import { blobKey } from "../canvas/storage-keys.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { DraftsRepository } from "../db/repositories/drafts.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { DeployError, LIMITS } from "./errors.js";
import type { DeployEntry } from "./ingest.js";
import { normalizeEntryPath } from "./validate.js";

export interface DeployResult {
  url: string;
  version: number;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
}

export interface DeployEngineDeps {
  config: Config;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
  log: Logger;
}

/** Published versions kept per canvas; older ready versions are pruned (§6.1.11). */
export const KEEP_VERSIONS = 10;

/**
 * How many file uploads run concurrently within one deploy. Each storage `put`
 * is a network round-trip on S3; uploading in parallel turns an N-round-trip
 * deploy into ~N/this. Capped so peak memory stays bounded (at most this many
 * file buffers in flight — the streaming zip reader still pulls one at a time;
 * see ingest `fromZip` / KTD-2) and so one deploy can't monopolize the client's
 * S3 connection pool.
 */
const PUT_CONCURRENCY = 8;

/**
 * The deploy engine (§9.5, KTD-3/4). Turns a stream of entries (from any of the
 * three ingestion adapters) into a new immutable version with an atomic pointer
 * swap and async pruning. Buffers at most one file at a time (KTD-2): each entry
 * is validated, hashed, and written to storage before the next is pulled.
 */
export function deployEngine(deps: DeployEngineDeps) {
  return {
    async deploy(
      canvas: Canvas,
      source: DeploySource,
      entries: AsyncIterable<DeployEntry> | Iterable<DeployEntry>,
      actorId: string,
    ): Promise<DeployResult> {
      // Concurrent deploys to one canvas can race nextNumber; the unique index on
      // (canvas_id, number) makes a collision a constraint error — retry rather
      // than surface a raw 500.
      const version = await this.createVersionWithRetry(canvas.id, actorId, source);

      const manifest: Manifest = {};
      const warnings: string[] = [];
      let fileCount = 0;
      let totalBytes = 0;
      // Content hashes already enqueued/written this deploy — identical bytes (same
      // path or different) upload at most once (content-addressed dedup, KTD-1).
      const seen = new Set<string>();

      // Uploads run in bounded-concurrency batches: validation stays sequential
      // (the running totals gate zip-bombs in order), but the slow part — the
      // storage round-trips — fans out PUT_CONCURRENCY at a time. Each blob is
      // written only if absent (content-addressed: an identical blob from a prior
      // version is reused, so a one-file edit writes one blob, AE1). `flush` waits
      // for the whole batch to SETTLE before surfacing any error, so no upload can
      // still be in flight when the failure path runs.
      let batch: Array<{ key: string; bytes: Uint8Array }> = [];
      const putBlobIfAbsent = async (key: string, bytes: Uint8Array): Promise<void> => {
        if (await deps.storage.exists(key)) return;
        await deps.storage.put(key, bytes);
      };
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const current = batch;
        batch = [];
        const results = await Promise.allSettled(
          current.map((f) => putBlobIfAbsent(f.key, f.bytes)),
        );
        const failed = results.find((r) => r.status === "rejected");
        if (failed) throw (failed as PromiseRejectedResult).reason;
      };

      try {
        for await (const entry of entries) {
          const path = normalizeEntryPath(entry.path); // throws on zip-slip / traversal
          if (path === null) continue; // dotfile / directory marker — stripped

          const size = entry.bytes.byteLength;
          if (size > LIMITS.maxFileBytes) {
            throw new DeployError("FILE_TOO_LARGE", `${path} exceeds 25 MB`, path);
          }
          totalBytes += size;
          if (totalBytes > LIMITS.maxCanvasBytes) {
            throw new DeployError("CANVAS_TOO_LARGE", "deploy exceeds 100 MB total");
          }
          fileCount++;
          if (fileCount > LIMITS.maxFiles) {
            throw new DeployError("TOO_MANY_FILES", "deploy exceeds 2000 files");
          }

          const mime = mimeFor(path);
          if (mime.downgraded) warnings.push(`${path} will be served as text/plain`);
          // Warn (don't block) if a text file appears to embed a canvas API key
          // (§12.1.2 — keys are server-side only, never in canvas files).
          if (mime.contentType.startsWith("text/") && looksLikeApiKey(decodeText(entry.bytes))) {
            warnings.push(`${path} may contain a canvas API key — remove it before deploying`);
          }

          const hash = createHash("sha256").update(entry.bytes).digest("hex");
          manifest[path] = { size, hash, mime: mime.contentType };
          if (!seen.has(hash)) {
            seen.add(hash);
            batch.push({ key: blobKey(canvas.id, hash), bytes: entry.bytes });
            if (batch.length >= PUT_CONCURRENCY) await flush();
          }
        }
        await flush();

        if (fileCount === 0) {
          throw new DeployError("EMPTY_DEPLOY", "no deployable files");
        }
        // Warn when the canvas root won't resolve: no index.html and not the
        // single-HTML-file case the serve resolver forgives. (One stray HTML
        // file IS served at the root, so that case isn't flagged.)
        if (!manifest["index.html"] && !soleHtmlEntry(manifest)) {
          warnings.push(
            "No index.html — visitors to the canvas root will get a 404. Name your entry file index.html.",
          );
        }
      } catch (err) {
        // Validation/storage failure: the pointer is untouched, so the live
        // version is unaffected. Blobs are content-addressed and may be shared
        // with the live version, so they are NEVER deleted inline — any blob this
        // failed attempt wrote that nothing references is reclaimed by the next GC
        // (KTD-4). The pending version row stays `pending` (not ready, not served).
        deps.log.warn(
          { err, canvasId: canvas.id },
          "deploy failed before publish (live unaffected)",
        );
        throw err;
      }

      // Atomic-ish swap: mark ready, then move the canvas pointer. The pointer
      // swap is the commit — a crash before it leaves the old version live. If the
      // swap throws, the version is ready-but-not-current (orphaned): its blobs may
      // be shared with the live version so they're left for GC, and the orphaned
      // ready row is pruned by keep-10. Nothing is served from it (never current).
      await deps.versions.markReady(version.id, { fileCount, totalBytes, manifest });
      await deps.canvases.setCurrentVersion(canvas.id, version.id);

      // Reconcile the in-browser draft with this direct publish (deploy API / folder
      // / ZIP / paste). If there are real held edits (a non-empty draft), preserve
      // them and just flag the draft stale so the editor shows the "a newer version
      // was published" notice (M5 R15/F3/AE5). But if there's no draft — or the draft
      // is empty, so there is nothing to lose — seed/sync it to the just-published
      // version (manifest + base = this version, stale cleared), exactly as the
      // editor's own Publish leaves things. That way an API/agent publish leaves the
      // editor reflecting production instead of an empty, perpetually-"behind" draft.
      // Best-effort — never fail the deploy over draft bookkeeping.
      try {
        const draft = await deps.drafts.getByCanvas(canvas.id);
        const draftEmpty = !draft || Object.keys(draft.manifest as Manifest).length === 0;
        if (!draftEmpty) {
          await deps.drafts.markStale(canvas.id);
        } else if (draft) {
          await deps.drafts.resetToBase(canvas.id, manifest, version.id);
        } else {
          await deps.drafts.create({ canvasId: canvas.id, manifest, baseVersionId: version.id });
        }
      } catch (err) {
        deps.log.warn({ err, canvasId: canvas.id }, "post-deploy draft sync failed");
      }

      // Prune old version rows + reclaim unreferenced blobs, asynchronously —
      // never block or fail the deploy. `.catch` guards against an unhandled
      // rejection if prune throws synchronously.
      this.prune(canvas.id).catch((err) => deps.log.error({ err }, "prune dispatch failed"));

      return {
        url: canvasUrl(deps.config, canvas.slug),
        version: version.number,
        fileCount,
        totalBytes,
        warnings,
      };
    },

    /** Create the pending version, retrying on a (canvas_id, number) collision. */
    async createVersionWithRetry(
      canvasId: string,
      actorId: string,
      source: DeploySource,
    ): Promise<Version> {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        const number = await deps.versions.nextNumber(canvasId);
        try {
          return await deps.versions.createPending({
            canvasId,
            number,
            createdBy: actorId,
            source,
          });
        } catch (err) {
          lastErr = err; // unique-constraint collision from a concurrent deploy — retry
        }
      }
      throw lastErr;
    },

    /**
     * Prune old version *rows* (keep the newest N), then reclaim blobs no
     * surviving version or the draft still references (per-canvas mark-sweep,
     * KTD-4). Log-and-continue on failure — the live version is never affected.
     */
    async prune(canvasId: string): Promise<void> {
      try {
        // pruneBeyond re-reads the live pointer atomically inside its DELETE, so a
        // concurrent rollback's current version is never pruned (prune-vs-rollback
        // race); no pre-read snapshot needed here. It deletes ROWS only.
        await deps.versions.pruneBeyond(canvasId, KEEP_VERSIONS);
      } catch (err) {
        deps.log.error({ err, canvasId }, "version row prune failed (live version unaffected)");
      }
      // Blob GC runs after row-pruning so dropped versions are out of the live set.
      // Best-effort and self-contained (logs its own failures).
      await collectGarbage(
        { versions: deps.versions, drafts: deps.drafts, storage: deps.storage, log: deps.log },
        canvasId,
      );
    },
  };
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export type DeployEngine = ReturnType<typeof deployEngine>;

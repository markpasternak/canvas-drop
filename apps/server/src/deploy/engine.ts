import { createHash } from "node:crypto";
import type { Config } from "@canvas-drop/shared";
import type { Canvas, DeploySource, Draft, Manifest, Version } from "@canvas-drop/shared/db";
import { looksLikeApiKey } from "../canvas/api-key.js";
import { collectGarbage } from "../canvas/blob-gc.js";
import { manifestsEqual, soleHtmlEntry } from "../canvas/manifest.js";
import { decodeText, isTextContentType, mimeFor } from "../canvas/mime.js";
import { blobKey } from "../canvas/storage-keys.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { DraftsRepository } from "../db/repositories/drafts.js";
import type { UploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { createPendingVersionWithRetry, KEEP_VERSIONS } from "./constants.js";
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
  /** In-flight upload sessions (plan 003) — joins the blob-GC live set + pruned on sweep. */
  uploadSessions?: UploadSessionsRepository;
  /** Screenshot capture trigger (plan 004 / U13) — effective-gated + best-effort; a
   *  deploy schedules a preview of the new version. Optional (absent in tests/when off). */
  screenshots?: import("../screenshots/trigger.js").ScreenshotTrigger;
}

// KEEP_VERSIONS now lives in ./constants.js (neutral home shared with the draft
// service); re-exported here for the existing import surface.
export { KEEP_VERSIONS };

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
          if (isTextContentType(mime.contentType) && looksLikeApiKey(decodeText(entry.bytes))) {
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

      await this.commitReadyVersion(canvas, version, manifest, fileCount, totalBytes);

      return {
        url: canvasUrl(deps.config, canvas.slug),
        version: version.number,
        fileCount,
        totalBytes,
        warnings,
      };
    },

    /**
     * Commit a `pending` version that already has its blobs in storage: mark it
     * ready, swap the live pointer, reconcile the draft, and kick async prune.
     * Shared by `deploy()` (blobs written inline) and the two-channel upload
     * finalize (blobs pre-staged, plan 003) — one commit tail, no parallel logic.
     */
    async commitReadyVersion(
      canvas: Canvas,
      version: Version,
      manifest: Manifest,
      fileCount: number,
      totalBytes: number,
    ): Promise<void> {
      // Atomic-ish swap: mark ready, then move the canvas pointer. The pointer
      // swap is the commit — a crash before it leaves the old version live. If the
      // swap throws, the version is ready-but-not-current (orphaned): its blobs may
      // be shared with the live version so they're left for GC, and the orphaned
      // ready row is pruned by keep-10. Nothing is served from it (never current).
      // `markReady` asserts exactly one row updated — a finalize whose canvas was
      // purged between createPending and here fails cleanly (plan 003 guard).
      await deps.versions.markReady(version.id, { fileCount, totalBytes, manifest });
      await deps.canvases.setCurrentVersion(canvas.id, version.id);

      // Schedule a preview capture of the freshly deployed version (plan 004 / U13).
      // Effective-gated + best-effort inside the trigger — never fails the deploy.
      await deps.screenshots?.enqueue(canvas, version.id);

      // Reconcile the in-browser draft with this direct publish (deploy API / folder
      // / ZIP / paste / upload). The editor must end up showing what was just deployed
      // UNLESS the owner has genuine unpublished edits to protect. We decide that by
      // what the draft holds RELATIVE TO ITS BASE VERSION, not merely whether it is
      // non-empty: the editor seeds a draft from the current version on open, so a
      // draft that still matches its base is an untouched working copy with nothing to
      // lose — the earlier "non-empty ⇒ held edits" heuristic wrongly flagged those
      // stale, so an API/agent deploy left the editor stuck on "a newer version was
      // published" with phantom unpublished changes (the reported bug). Now:
      //   - no draft yet            → seed it to the just-published version
      //   - draft == its base       → no real edits → sync to the new version
      //   - draft diverges from base → genuine held edits → preserve + flag stale
      //     so the editor shows the "a newer version was published" notice (R15/F3/AE5)
      // Best-effort — never fail the deploy over draft bookkeeping.
      try {
        const draft = await deps.drafts.getByCanvas(canvas.id);
        if (!draft) {
          await deps.drafts.create({ canvasId: canvas.id, manifest, baseVersionId: version.id });
        } else if (await this.draftHasUnpublishedEdits(draft)) {
          await deps.drafts.markStale(canvas.id);
        } else {
          await deps.drafts.resetToBase(canvas.id, manifest, version.id);
        }
      } catch (err) {
        deps.log.warn({ err, canvasId: canvas.id }, "post-deploy draft sync failed");
      }

      // Prune old version rows + reclaim unreferenced blobs, asynchronously —
      // never block or fail the deploy. `.catch` guards against an unhandled
      // rejection if prune throws synchronously.
      this.prune(canvas.id).catch((err) => deps.log.error({ err }, "prune dispatch failed"));
    },

    /** Create the pending version, retrying on a (canvas_id, number) collision. */
    createVersionWithRetry(
      canvasId: string,
      actorId: string,
      source: DeploySource,
    ): Promise<Version> {
      // Delegates to the shared helper (review server-canvas-10) so the draft
      // service's publish path runs the exact same collision-retry policy.
      return createPendingVersionWithRetry(deps.versions, canvasId, actorId, source);
    },

    /**
     * Whether the draft holds genuine unpublished edits relative to the version it
     * was derived from — the signal for whether a direct publish must preserve it.
     *   - empty draft               → no edits (nothing to lose)
     *   - no/unknown base version    → treat as edits (author had no version to
     *     diverge from, or the base was pruned — preserve rather than risk clobbering)
     *   - manifest == base manifest  → untouched working copy → no edits
     *   - manifest != base manifest  → real held edits
     */
    async draftHasUnpublishedEdits(draft: Draft): Promise<boolean> {
      const draftManifest = (draft.manifest as Manifest | null) ?? {};
      if (Object.keys(draftManifest).length === 0) return false;
      if (!draft.baseVersionId) return true;
      const base = await deps.versions.findById(draft.baseVersionId);
      const baseManifest = base?.manifest as Manifest | null;
      if (!baseManifest) return true;
      return !manifestsEqual(draftManifest, baseManifest);
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
      // Reclaim expired upload-session rows BEFORE the sweep so their (now dead)
      // manifests drop out of the live set and their orphan blobs are reclaimed in
      // this same pass (plan 003 U7). Best-effort; global + idempotent.
      if (deps.uploadSessions) {
        await deps.uploadSessions
          .deleteExpired(Date.now())
          .catch((err) => deps.log.error({ err, canvasId }, "expired upload-session prune failed"));
      }
      // Blob GC runs after row-pruning so dropped versions are out of the live set.
      // Best-effort and self-contained (logs its own failures).
      await collectGarbage(
        {
          versions: deps.versions,
          drafts: deps.drafts,
          storage: deps.storage,
          log: deps.log,
          uploadSessions: deps.uploadSessions,
        },
        canvasId,
      );
    },
  };
}

export type DeployEngine = ReturnType<typeof deployEngine>;

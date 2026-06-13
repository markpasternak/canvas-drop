import { createHash } from "node:crypto";
import type { Config } from "@canvas-drop/shared";
import type { Canvas, DeploySource, Manifest, Version } from "@canvas-drop/shared/db";
import { looksLikeApiKey } from "../canvas/api-key.js";
import { mimeFor } from "../canvas/mime.js";
import { versionStorageKey } from "../canvas/storage-keys.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
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
  storage: StorageDriver;
  log: Logger;
}

const KEEP_VERSIONS = 10;

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
          await deps.storage.put(versionStorageKey(version.id, path), entry.bytes);
        }

        if (fileCount === 0) {
          throw new DeployError("EMPTY_DEPLOY", "no deployable files");
        }
      } catch (err) {
        // Validation/storage failure: the pointer is untouched, so the live
        // version is unaffected. Best-effort clean up the orphaned pending writes.
        await this.cleanupPending(version.id, manifest).catch(() => {});
        throw err;
      }

      // Atomic-ish swap: mark ready, then move the canvas pointer. The pointer
      // swap is the commit — a crash before it leaves the old version live.
      await deps.versions.markReady(version.id, { fileCount, totalBytes, manifest });
      await deps.canvases.setCurrentVersion(canvas.id, version.id);

      // Prune beyond the last 10, asynchronously — never block or fail the deploy.
      // `.catch` guards against an unhandled rejection if prune throws synchronously.
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

    /** Delete the storage objects written for a failed pending version. */
    async cleanupPending(versionId: string, manifest: Manifest): Promise<void> {
      for (const path of Object.keys(manifest)) {
        await deps.storage.delete(versionStorageKey(versionId, path)).catch(() => {});
      }
    },

    /** Prune ready versions beyond the newest N; log-and-continue on failure. */
    async prune(canvasId: string): Promise<void> {
      try {
        // pruneBeyond re-reads the live pointer atomically inside its DELETE, so a
        // concurrent rollback's current version is never pruned (prune-vs-rollback
        // race); no pre-read snapshot needed here.
        const dropped = await deps.versions.pruneBeyond(canvasId, KEEP_VERSIONS);
        for (const v of dropped) {
          const manifest = (v.manifest ?? {}) as Manifest;
          for (const path of Object.keys(manifest)) {
            await deps.storage.delete(versionStorageKey(v.id, path)).catch(() => {});
          }
        }
      } catch (err) {
        deps.log.error({ err, canvasId }, "version prune failed (live version unaffected)");
      }
    },
  };
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export type DeployEngine = ReturnType<typeof deployEngine>;

import { createHash } from "node:crypto";
import type { Config } from "@canvas-drop/shared";
import type { Canvas, Draft, Manifest, Version } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import { collectGarbage } from "../canvas/blob-gc.js";
import { mimeFor } from "../canvas/mime.js";
import { blobKey } from "../canvas/storage-keys.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { DraftsRepository } from "../db/repositories/drafts.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { KEEP_VERSIONS } from "../deploy/engine.js";
import { DeployError, LIMITS } from "../deploy/errors.js";
import { normalizeEntryPath } from "../deploy/validate.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";

export interface DraftServiceDeps {
  config: Config;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
  audit: AuditLog;
  log: Logger;
  /**
   * Screenshot capture enqueue (plan 004 / U6). Optional — present only when the
   * screenshot pipeline is enabled. Publishing schedules a (coalesced) capture of the
   * new version; the in-process worker picks it up. Best-effort: a failure here must
   * never fail the publish.
   */
  screenshots?: { enqueue(canvasId: string, versionId: string): Promise<void> };
}

export interface PublishResult {
  version: number;
  versionId: string;
  fileCount: number;
  totalBytes: number;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const manifestStats = (manifest: Manifest): { fileCount: number; totalBytes: number } => {
  let totalBytes = 0;
  for (const entry of Object.values(manifest)) totalBytes += entry.size;
  return { fileCount: Object.keys(manifest).length, totalBytes };
};

/**
 * Draft lifecycle (M5, R10–R15). Each canvas has exactly one mutable draft — a
 * manifest over content-addressed blobs. The in-browser editor mutates the draft
 * (writes a blob + updates the manifest, NEVER a version); an explicit Publish
 * snapshots the manifest into a new immutable version and swaps the live pointer.
 * Restore copies a published version's manifest back into the draft.
 *
 * Blobs written here are reclaimed by the same per-canvas mark-sweep GC as deploys
 * (KTD-4) — draft churn (a file edited h1→h2) leaves h1 for the next sweep.
 */
export function draftService(deps: DraftServiceDeps) {
  const service = {
    /** The canvas's draft, creating it from the live version (or empty) on first touch (R10). */
    async getOrCreate(canvas: Canvas): Promise<Draft> {
      const existing = await deps.drafts.getByCanvas(canvas.id);
      if (existing) return existing;
      let manifest: Manifest = {};
      let baseVersionId: string | null = null;
      if (canvas.currentVersionId) {
        const live = await deps.versions.findById(canvas.currentVersionId);
        if (live?.status === "ready" && live.manifest) {
          manifest = live.manifest as Manifest;
          baseVersionId = live.id;
        }
      }
      try {
        return await deps.drafts.create({ canvasId: canvas.id, manifest, baseVersionId });
      } catch (err) {
        // Two concurrent first-touch requests (e.g. GET /draft + an autosave PUT on
        // first open) both see no draft and both insert; the unique canvas_id index
        // makes the loser throw. Re-read and return the winner's row (insert-or-get).
        const raced = await deps.drafts.getByCanvas(canvas.id);
        if (raced) return raced;
        throw err;
      }
    },

    /** Read a draft file's bytes, or null if the path isn't in the draft (R13 raw read). */
    async readFile(canvas: Canvas, path: string): Promise<Uint8Array | null> {
      const draft = await deps.drafts.getByCanvas(canvas.id);
      const entry = draft ? (draft.manifest as Manifest)[path] : undefined;
      if (!entry) return null;
      return deps.storage.get(blobKey(canvas.id, entry.hash));
    },

    /**
     * Write/replace a draft file: hash → blob → manifest. No version (R11/AE1).
     * `mustNotExist` makes it a *create* (used by "Add a file"): if the path is
     * already in the draft it throws PATH_EXISTS instead of silently truncating the
     * existing file's content to the new (often empty) bytes.
     */
    async writeFile(
      canvas: Canvas,
      rawPath: string,
      bytes: Uint8Array,
      opts: { mustNotExist?: boolean } = {},
    ): Promise<Draft> {
      const path = normalizeEntryPath(rawPath);
      if (path === null) {
        throw new DeployError("INVALID_PATH", `not a writable file path: ${rawPath}`, rawPath);
      }
      const size = bytes.byteLength;
      if (size > LIMITS.maxFileBytes) {
        throw new DeployError("FILE_TOO_LARGE", `${path} exceeds 25 MB`, path);
      }
      const draft = await service.getOrCreate(canvas);
      if (opts.mustNotExist && (draft.manifest as Manifest)[path]) {
        throw new DeployError("PATH_EXISTS", `a file already exists at ${path}`, path);
      }
      const next: Manifest = { ...(draft.manifest as Manifest) };
      const hash = sha256(bytes);
      next[path] = { size, hash, mime: mimeFor(path).contentType };

      const stats = manifestStats(next);
      if (stats.totalBytes > LIMITS.maxCanvasBytes) {
        throw new DeployError("CANVAS_TOO_LARGE", "draft exceeds 100 MB total");
      }
      if (stats.fileCount > LIMITS.maxFiles) {
        throw new DeployError("TOO_MANY_FILES", "draft exceeds 2000 files");
      }

      // Idempotent: an identical blob (same content elsewhere in the canvas) is reused.
      if (!(await deps.storage.exists(blobKey(canvas.id, hash)))) {
        await deps.storage.put(blobKey(canvas.id, hash), bytes);
      }
      return deps.drafts.setManifest(canvas.id, next);
    },

    /** Remove a file from the draft (blob left for GC). */
    async deleteFile(canvas: Canvas, path: string): Promise<Draft> {
      const draft = await service.getOrCreate(canvas);
      const next: Manifest = { ...(draft.manifest as Manifest) };
      if (!next[path]) throw new DeployError("INVALID_PATH", `no such draft file: ${path}`, path);
      delete next[path];
      return deps.drafts.setManifest(canvas.id, next);
    },

    /** Move a file within the draft (same blob, new path) — rename or relocate. */
    async renameFile(canvas: Canvas, from: string, rawTo: string): Promise<Draft> {
      const to = normalizeEntryPath(rawTo);
      if (to === null) {
        throw new DeployError("INVALID_PATH", `not a writable file path: ${rawTo}`, rawTo);
      }
      const draft = await service.getOrCreate(canvas);
      const next: Manifest = { ...(draft.manifest as Manifest) };
      const entry = next[from];
      if (!entry) throw new DeployError("INVALID_PATH", `no such draft file: ${from}`, from);
      if (to === from) return draft; // no-op rename (after normalization) — nothing to do
      // Renaming onto a different existing file would silently destroy that file —
      // refuse it (the editor surfaces PATH_EXISTS as inline validation).
      if (next[to]) {
        throw new DeployError("PATH_EXISTS", `a file already exists at ${to}`, to);
      }
      delete next[from];
      next[to] = entry;
      return deps.drafts.setManifest(canvas.id, next);
    },

    /**
     * Freeze the draft into a new immutable published version and swap the live
     * pointer (R12/AE2/AE3). Blobs already exist (written during editing), so this
     * is a manifest + pointer operation, not a byte copy. After publishing, the
     * draft equals the live version (stale cleared, base = the new version).
     */
    async publish(canvas: Canvas, actorId: string): Promise<PublishResult> {
      const draft = await service.getOrCreate(canvas);
      const manifest = draft.manifest as Manifest;
      const { fileCount, totalBytes } = manifestStats(manifest);
      if (fileCount === 0) {
        throw new DeployError("EMPTY_DEPLOY", "nothing to publish — the draft is empty");
      }

      const version = await service.createReadyVersion(canvas.id, actorId, manifest, {
        fileCount,
        totalBytes,
      });
      await deps.canvases.setCurrentVersion(canvas.id, version.id);
      deps.audit.recordAudit({
        action: "publish",
        actorId,
        targetId: canvas.id,
        meta: { version: version.number, fileCount },
      });
      // The draft now mirrors the freshly published version. The version is already
      // live, so a failure here must NOT fail the publish (it would surface a 500 for
      // an action that actually succeeded, and a retry would double-publish). Best-
      // effort: log and continue; the worst case is a draft that still shows
      // unpublished-changes until the next edit/publish.
      await deps.drafts
        .resetToBase(canvas.id, manifest, version.id)
        .catch((err) =>
          deps.log.warn({ err, canvasId: canvas.id }, "post-publish draft reset failed"),
        );

      // Schedule a screenshot capture of the freshly published version (plan 004 / U6).
      // Coalesced (one job per canvas, latest version wins) and best-effort — a failed
      // enqueue must never fail a publish that already succeeded. Only when enabled.
      if (deps.config.screenshots.enabled && deps.screenshots) {
        await deps.screenshots
          .enqueue(canvas.id, version.id)
          .catch((err) => deps.log.warn({ err, canvasId: canvas.id }, "screenshot enqueue failed"));
      }

      // Prune old rows + reclaim unreferenced blobs, async + best-effort.
      service.pruneAndCollect(canvas.id);
      return { version: version.number, versionId: version.id, fileCount, totalBytes };
    },

    /** Restore a published version's files into the draft (R14/AE3) — never edits the version. */
    async restore(canvas: Canvas, versionNumber: number): Promise<Draft> {
      const target = await deps.versions.findReadyByNumber(canvas.id, versionNumber);
      if (!target?.manifest) {
        throw new DeployError("INVALID_PATH", `no ready version ${versionNumber}`);
      }
      await service.getOrCreate(canvas); // ensure the draft row exists
      return deps.drafts.resetToBase(canvas.id, target.manifest as Manifest, target.id);
    },

    /** Create a `ready` version with the given manifest, retrying on a number collision. */
    async createReadyVersion(
      canvasId: string,
      actorId: string,
      manifest: Manifest,
      stats: { fileCount: number; totalBytes: number },
    ): Promise<Version> {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        const number = await deps.versions.nextNumber(canvasId);
        try {
          const pending = await deps.versions.createPending({
            canvasId,
            number,
            createdBy: actorId,
            source: "editor",
          });
          return await deps.versions.markReady(pending.id, { ...stats, manifest });
        } catch (err) {
          lastErr = err; // (canvas_id, number) collision from a concurrent publish/deploy — retry
        }
      }
      throw lastErr;
    },

    /** Fire-and-forget row prune + blob GC, mirroring the deploy engine's prune. */
    pruneAndCollect(canvasId: string): void {
      void (async () => {
        try {
          await deps.versions.pruneBeyond(canvasId, KEEP_VERSIONS);
        } catch (err) {
          deps.log.error({ err, canvasId }, "publish row prune failed (live unaffected)");
        }
        await collectGarbage(
          { versions: deps.versions, drafts: deps.drafts, storage: deps.storage, log: deps.log },
          canvasId,
        );
      })().catch((err) => deps.log.error({ err, canvasId }, "publish prune dispatch failed"));
    },
  };

  return service;
}

export type DraftService = ReturnType<typeof draftService>;

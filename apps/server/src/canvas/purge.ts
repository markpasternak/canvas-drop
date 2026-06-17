import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { DraftsRepository } from "../db/repositories/drafts.js";
import type { ScreenshotsRepository } from "../db/repositories/screenshots.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { canvasBlobPrefix, screenshotPrefix } from "./storage-keys.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeDeps {
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
  log: Logger;
  /** Screenshot jobs (plan 004 / U10) — the canvas's preview prefix + job row are
   *  reclaimed alongside its blobs. Optional (absent when the pipeline isn't wired). */
  screenshots?: Pick<ScreenshotsRepository, "deleteByCanvas">;
}

export interface PurgeOptions {
  /**
   * Retention window in days. `0` (the default) purges *every* soft-deleted
   * canvas; a positive number purges only those soft-deleted at least that many
   * days ago.
   */
  olderThanDays?: number;
  /** Report what would be purged without deleting anything. */
  dryRun?: boolean;
  /** Injectable clock — the cutoff is `now - olderThanDays`. Defaults to wall time. */
  now?: number;
}

export interface PurgeSummary {
  /** Soft-deleted canvases whose files + versions were (or would be) reclaimed. */
  canvasesPurged: number;
  /** Version rows hard-deleted across all reclaimed canvases. */
  versionsPurged: number;
  /** Storage objects deleted across all reclaimed canvases. */
  objectsDeleted: number;
  /** Canvases skipped because a step threw — left fully intact for the next run. */
  failed: number;
}

/**
 * Reclaim the heavy data of soft-deleted canvases (BUILD_BRIEF §6.1 #14).
 *
 * Deleting a canvas only flips `status = "deleted"` + stamps `deletedAt`. This
 * sweep hard-deletes the reclaimable parts — every version's **storage objects**
 * (the deployed files; the whole point) and its **version rows** (file
 * metadata) — but intentionally **keeps the canvas row** as a soft-deleted
 * tombstone (its identity/audit record). The canvas's `currentVersionId` is
 * cleared so it no longer dangles at a removed version.
 *
 * Order per canvas is load-bearing: storage objects, then version rows —
 * `versions.canvas_id` references `canvases.id` with no cascade, and we remove
 * the version rows before clearing the pointer. Each canvas is processed
 * independently and storage-first: if any step throws, it is logged and skipped
 * with its rows untouched, so a transient storage failure is safe to retry
 * rather than orphaning objects whose owning rows are already gone.
 *
 * Canvases with no version rows are skipped (never deployed, or already swept on
 * a prior run), so re-running is idempotent — a second pass reports zero.
 */
export async function purgeDeletedCanvases(
  deps: PurgeDeps,
  { olderThanDays = 0, dryRun = false, now = Date.now() }: PurgeOptions = {},
): Promise<PurgeSummary> {
  const cutoffMs = olderThanDays > 0 ? now - olderThanDays * DAY_MS : null;
  const doomed = await deps.canvases.listDeletedBefore(cutoffMs);

  const summary: PurgeSummary = {
    canvasesPurged: 0,
    versionsPurged: 0,
    objectsDeleted: 0,
    failed: 0,
  };

  for (const canvas of doomed) {
    try {
      const versions = await deps.versions.listByCanvas(canvas.id);
      const draft = await deps.drafts.getByCanvas(canvas.id);
      // Under content-addressing every blob for the canvas lives under one
      // per-canvas prefix, so a single list+deleteMany reclaims them all (the
      // canvas dies whole — no refcounting needed, KTD-1). Includes draft-only
      // blobs (a canvas drafted but never published).
      const keys = await deps.storage.list(canvasBlobPrefix(canvas.id));
      // The canvas's one preview set (plan 004 / U10) lives under its own prefix —
      // reclaim it in the same pass.
      const shotKeys = await deps.storage.list(screenshotPrefix(canvas.id));

      // Nothing reclaimable — leave the tombstone untouched and don't count it
      // (keeps re-runs idempotent: a second pass reports zero).
      if (versions.length === 0 && draft === null && keys.length === 0 && shotKeys.length === 0) {
        continue;
      }

      if (!dryRun) {
        await deps.storage.deleteMany([...keys, ...shotKeys]);
        await deps.versions.deleteByCanvas(canvas.id);
        await deps.drafts.deleteByCanvas(canvas.id);
        await deps.screenshots?.deleteByCanvas(canvas.id);
        await deps.canvases.clearCurrentVersion(canvas.id);
      }
      const objects = keys.length + shotKeys.length;
      summary.canvasesPurged++;
      summary.versionsPurged += versions.length;
      summary.objectsDeleted += objects;
      deps.log.info(
        { canvasId: canvas.id, slug: canvas.slug, versions: versions.length, objects, dryRun },
        dryRun ? "would reclaim soft-deleted canvas" : "reclaimed soft-deleted canvas",
      );
    } catch (err) {
      summary.failed++;
      deps.log.error(
        { err, canvasId: canvas.id, slug: canvas.slug },
        "purge failed for canvas; left intact for retry",
      );
    }
  }

  return summary;
}

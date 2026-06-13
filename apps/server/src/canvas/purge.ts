import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { versionPrefix } from "./storage-keys.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeDeps {
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  storage: StorageDriver;
  log: Logger;
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
  /** Canvases whose rows were (or would be) removed. */
  canvasesPurged: number;
  /** Version rows removed across all purged canvases. */
  versionsPurged: number;
  /** Storage objects deleted across all purged canvases. */
  objectsDeleted: number;
  /** Canvases skipped because a step threw — left fully intact for the next run. */
  failed: number;
}

/**
 * Permanently purge soft-deleted canvases (BUILD_BRIEF §6.1 #14). Soft-delete
 * only flips `status` + stamps `deletedAt`; this is the sweep that actually
 * reclaims the row, its versions, and their storage objects.
 *
 * Order per canvas is load-bearing: storage objects, then version rows, then the
 * canvas row — `versions.canvas_id` references `canvases.id` with no cascade, so
 * the canvas row cannot go first. Each canvas is purged independently and
 * storage-first: if any step throws, that canvas is logged and skipped with its
 * rows untouched, so a transient storage failure is safe to retry rather than
 * orphaning objects whose owning rows are already gone.
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
      let objects = 0;
      for (const version of versions) {
        for (const key of await deps.storage.list(versionPrefix(version.id))) {
          if (!dryRun) await deps.storage.delete(key);
          objects++;
        }
      }
      if (!dryRun) {
        await deps.versions.deleteByCanvas(canvas.id);
        await deps.canvases.hardDelete(canvas.id);
      }
      summary.canvasesPurged++;
      summary.versionsPurged += versions.length;
      summary.objectsDeleted += objects;
      deps.log.info(
        { canvasId: canvas.id, slug: canvas.slug, versions: versions.length, objects, dryRun },
        dryRun ? "would purge soft-deleted canvas" : "purged soft-deleted canvas",
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

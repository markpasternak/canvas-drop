import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { DraftsRepository } from "../db/repositories/drafts.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { KvRepository } from "../db/repositories/kv.js";
import type { ScreenshotsRepository } from "../db/repositories/screenshots.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { canvasBlobPrefix, canvasFilesPrefix, screenshotPrefix } from "./storage-keys.js";

const DAY_MS = 86_400_000;
export const ADMIN_PURGE_RETENTION_DAYS = 30;
// Deploy and screenshot workers are bounded well below this window. Old pending
// rows represent abandoned work and can be reclaimed after the retention period.
const IN_FLIGHT_WINDOW_MS = 3_600_000;

export interface PurgeDeps {
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
  log: Logger;
  screenshots?: Pick<ScreenshotsRepository, "deleteByCanvas">;
  files?: Pick<FilesRepository, "deleteByCanvas">;
  kv?: Pick<KvRepository, "deleteByCanvas">;
}
export interface PurgeOptions {
  /** CLI maintenance may choose a shorter window; the online admin always uses 30 days. */
  olderThanDays?: number;
  dryRun?: boolean;
  now?: number;
  expectedUpdatedAt?: number;
}
export interface PurgeSummary {
  canvasesPurged: number;
  versionsPurged: number;
  objectsDeleted: number;
  /** Cleanup can be partial. The tombstone remains unavailable and can be retried. */
  failed: number;
}
export type PurgeStatus =
  | "purged"
  | "already_purged"
  | "not_found"
  | "not_deleted"
  | "retained"
  | "changed"
  | "busy"
  | "failed";
export interface PurgeResult {
  status: PurgeStatus;
  versionsPurged: number;
  objectsDeleted: number;
}

/** Reclaim precisely one canvas. Content-addressed storage is namespaced per
 * canvas, so deleting these prefixes cannot remove another canvas's shared hash.
 * Claim before any destructive step: restore uses the complementary atomic guard.
 * Storage-first avoids orphaned data; any partial failure keeps a terminal marker
 * and the remaining data is safely retried. No private values leave this service. */
export async function purgeCanvas(
  deps: PurgeDeps,
  id: string,
  options: PurgeOptions = {},
): Promise<PurgeResult> {
  const now = options.now ?? Date.now();
  const cutoff = now - (options.olderThanDays ?? 0) * DAY_MS;
  const result = (status: PurgeStatus): PurgeResult => ({
    status,
    versionsPurged: 0,
    objectsDeleted: 0,
  });
  try {
    const canvas = await deps.canvases.findById(id);
    if (!canvas) return result("not_found");
    if (canvas.status !== "deleted") return result("not_deleted");
    if (canvas.purgedAt !== null) return result("already_purged");
    if (canvas.deletedAt === null || canvas.deletedAt > cutoff) return result("retained");
    if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== canvas.updatedAt)
      return result("changed");
    const versions = await deps.versions.listByCanvas(id);
    if (versions.some((v) => v.status === "pending" && v.createdAt > now - IN_FLIGHT_WINDOW_MS))
      return result("busy");
    if (!options.dryRun && !(await deps.canvases.claimPurge(id, canvas.updatedAt, cutoff, now)))
      return result("changed");
    const [keys, shotKeys, fileKeys] = await Promise.all([
      deps.storage.list(canvasBlobPrefix(id)),
      deps.storage.list(screenshotPrefix(id)),
      deps.storage.list(canvasFilesPrefix(id)),
    ]);
    if (!options.dryRun) {
      await deps.storage.deleteMany([...keys, ...shotKeys, ...fileKeys]);
      await deps.versions.deleteByCanvas(id);
      await deps.drafts.deleteByCanvas(id);
      await deps.screenshots?.deleteByCanvas(id);
      await deps.files?.deleteByCanvas(id);
      await deps.kv?.deleteByCanvas(id);
      await deps.canvases.finishPurge(id, now);
    }
    return {
      status: "purged",
      versionsPurged: versions.length,
      objectsDeleted: keys.length + shotKeys.length + fileKeys.length,
    };
  } catch (err) {
    deps.log.error(
      { err, canvasId: id },
      "canvas cleanup incomplete; retry required; restoration remains unavailable once cleanup starts",
    );
    return result("failed");
  }
}

/** CLI sweep shares the same per-canvas cleanup and permanent state as the UI. */
export async function purgeDeletedCanvases(
  deps: PurgeDeps,
  options: PurgeOptions = {},
): Promise<PurgeSummary> {
  const now = options.now ?? Date.now();
  const doomed = await deps.canvases.listDeletedBefore(now - (options.olderThanDays ?? 0) * DAY_MS);
  const summary: PurgeSummary = {
    canvasesPurged: 0,
    versionsPurged: 0,
    objectsDeleted: 0,
    failed: 0,
  };
  for (const canvas of doomed) {
    const outcome = await purgeCanvas(deps, canvas.id, {
      ...options,
      now,
      expectedUpdatedAt: canvas.updatedAt,
    });
    if (outcome.status === "purged") {
      summary.canvasesPurged++;
      summary.versionsPurged += outcome.versionsPurged;
      summary.objectsDeleted += outcome.objectsDeleted;
      deps.log.info(
        { canvasId: canvas.id, ...outcome, dryRun: options.dryRun ?? false },
        "canvas purge",
      );
    } else if (outcome.status === "failed" || outcome.status === "busy") summary.failed++;
  }
  return summary;
}

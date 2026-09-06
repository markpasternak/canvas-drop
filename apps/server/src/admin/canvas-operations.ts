import type { Canvas } from "@canvas-drop/shared/db";
import { z } from "zod";
import type { AuditLog } from "../audit/audit-log.js";
import { ADMIN_PURGE_RETENTION_DAYS, type PurgeDeps, purgeCanvas } from "../canvas/purge.js";
import { canvasBlobPrefix, canvasFilesPrefix, screenshotPrefix } from "../canvas/storage-keys.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { KvRepository } from "../db/repositories/kv.js";
import type { RealtimeHub } from "../realtime/hub.js";

export const CANVAS_OPERATIONS = [
  "disable",
  "enable",
  "archive",
  "unarchive",
  "delete",
  "restore",
  "purge",
] as const;
export type CanvasOperation = (typeof CANVAS_OPERATIONS)[number];
const ids = z
  .array(z.string().min(1).max(100))
  .min(1)
  .max(50)
  .refine((v) => new Set(v).size === v.length);
export const canvasOperationPreviewBody = z.object({ action: z.enum(CANVAS_OPERATIONS), ids });
export const canvasOperationExecuteBody = z.object({
  action: z.enum(CANVAS_OPERATIONS),
  items: z
    .array(z.object({ id: z.string().min(1).max(100), updatedAt: z.number().int().nonnegative() }))
    .min(1)
    .max(50)
    .refine((v) => new Set(v.map((i) => i.id)).size === v.length),
  reason: z.string().trim().min(1).max(500),
  confirmation: z.string(),
});
export interface CanvasOperationDeps extends PurgeDeps {
  audit: AuditLog;
  hub?: RealtimeHub;
  files: FilesRepository;
  kv: KvRepository;
}

function unavailable(canvas: Canvas, action: CanvasOperation, now: number): string | null {
  if (action === "purge") {
    if (canvas.purgedAt !== null) return "Already permanently purged";
    if (canvas.status !== "deleted") return "Delete this canvas first";
    if (
      canvas.deletedAt === null ||
      canvas.deletedAt + ADMIN_PURGE_RETENTION_DAYS * 86_400_000 > now
    )
      return "Retained for 30 days after deletion";
    return null;
  }
  if (canvas.purgeStartedAt !== null)
    return "Permanent cleanup has started; restoration is unavailable";
  const expected = {
    disable: "active",
    enable: "disabled",
    archive: "active",
    unarchive: "archived",
    restore: "deleted",
  } as const;
  if (action === "delete") return canvas.status === "deleted" ? "Already deleted" : null;
  return canvas.status === expected[action] ? null : `Requires ${expected[action]} status`;
}

export function canvasOperations(deps: CanvasOperationDeps) {
  return {
    async preview(action: CanvasOperation, ids: string[], now = Date.now()) {
      const items = [];
      for (const id of ids) {
        const canvas = await deps.canvases.findById(id);
        if (!canvas) {
          items.push({
            id,
            title: id,
            updatedAt: null,
            eligible: false,
            explanation: "Canvas no longer exists",
            resources: null,
          });
          continue;
        }
        let explanation = unavailable(canvas, action, now);
        const versions = action === "purge" ? await deps.versions.listByCanvas(id) : [];
        if (
          !explanation &&
          versions.some((v) => v.status === "pending" && v.createdAt > now - 3_600_000)
        )
          explanation = "A deployment is still in progress. Try again later.";
        const draft = action === "purge" ? await deps.drafts.getByCanvas(id) : null;
        const storageObjects =
          action === "purge"
            ? (
                await Promise.all(
                  [canvasBlobPrefix(id), canvasFilesPrefix(id), screenshotPrefix(id)].map(
                    (prefix) => deps.storage.list(prefix),
                  ),
                )
              ).reduce((n, keys) => n + keys.length, 0)
            : 0;
        const [fileCount, fileBytes, kvRows] =
          action === "purge"
            ? await Promise.all([
                deps.files.countFiles(id),
                deps.files.bytesByCanvas([id]),
                deps.kv.countByCanvas(id),
              ])
            : [0, new Map<string, number>(), 0];
        items.push({
          id,
          title: canvas.title || canvas.slug,
          updatedAt: canvas.updatedAt,
          eligible: explanation === null,
          explanation,
          resources:
            action === "purge"
              ? {
                  versions: versions.length,
                  storageObjects,
                  versionBytes: versions.reduce((n, v) => n + v.totalBytes, 0),
                  hasDraft: draft !== null,
                  fileCount,
                  fileBytes: fileBytes.get(id) ?? 0,
                  kvRows,
                  eligibleAt:
                    canvas.deletedAt === null
                      ? null
                      : canvas.deletedAt + ADMIN_PURGE_RETENTION_DAYS * 86_400_000,
                  cleanupStarted: canvas.purgeStartedAt !== null,
                }
              : null,
        });
      }
      return { action, items, retentionDays: ADMIN_PURGE_RETENTION_DAYS };
    },
    async execute(
      input: z.infer<typeof canvasOperationExecuteBody>,
      actorId: string,
      now = Date.now(),
    ) {
      if (input.confirmation !== `${input.action.toUpperCase()} ${input.items.length}`)
        throw new Error("CONFIRMATION_REQUIRED");
      const outcomes: Array<{ id: string; status: string; message: string }> = [];
      for (const item of input.items) {
        try {
          const canvas = await deps.canvases.findById(item.id);
          const refusal = !canvas
            ? "Canvas no longer exists"
            : unavailable(canvas, input.action, now);
          if (refusal || !canvas) {
            outcomes.push({ id: item.id, status: "skipped", message: refusal ?? "Unavailable" });
            continue;
          }
          if (canvas.updatedAt !== item.updatedAt) {
            outcomes.push({
              id: item.id,
              status: "changed",
              message: "Changed since preview. Review it again.",
            });
            continue;
          }
          if (input.action === "purge") {
            const result = await purgeCanvas(deps, item.id, {
              olderThanDays: ADMIN_PURGE_RETENTION_DAYS,
              expectedUpdatedAt: item.updatedAt,
              now,
            });
            if (result.status === "purged") {
              deps.audit.recordAudit({
                action: "canvas_purge",
                targetType: "canvas",
                targetId: item.id,
                actorId,
                meta: {
                  reason: input.reason,
                  versionsPurged: result.versionsPurged,
                  objectsDeleted: result.objectsDeleted,
                },
              });
            } else if (result.status === "failed") {
              deps.audit.recordAudit({
                action: "canvas_purge_failed",
                targetType: "canvas",
                targetId: item.id,
                actorId,
                meta: { reason: input.reason },
              });
            }
            outcomes.push({
              id: item.id,
              status: result.status,
              message:
                result.status === "purged"
                  ? "Permanently purged; audit record retained"
                  : result.status === "failed"
                    ? "Cleanup may be partial. Restore is unavailable. Preview and retry cleanup."
                    : "Canvas changed or is ineligible. Preview again.",
            });
            continue;
          }
          const methods = {
            disable: () => deps.canvases.setDisabled(item.id, input.reason, item.updatedAt),
            enable: () => deps.canvases.enable(item.id, item.updatedAt),
            archive: () => deps.canvases.archive(item.id, item.updatedAt),
            unarchive: () => deps.canvases.unarchive(item.id, item.updatedAt),
            delete: () => deps.canvases.adminDelete(item.id, item.updatedAt),
            restore: () => deps.canvases.restore(item.id, item.updatedAt),
          };
          const changed = await methods[input.action]();
          if (changed) {
            deps.hub?.dropCanvas(item.id);
            deps.audit.recordAudit({
              action: `canvas_${input.action}`,
              actorId,
              targetType: "canvas",
              targetId: item.id,
              meta: { reason: input.reason },
            });
          }
          outcomes.push({
            id: item.id,
            status: changed ? "done" : "changed",
            message: changed ? "Completed" : "Changed since preview. Review it again.",
          });
        } catch (err) {
          deps.log.error(
            { err, canvasId: item.id, action: input.action },
            "admin canvas operation failed",
          );
          outcomes.push({
            id: item.id,
            status: "failed",
            message: "Operation failed. Refresh and review before retrying.",
          });
        }
      }
      return { outcomes };
    },
  };
}

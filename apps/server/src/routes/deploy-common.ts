import type { Canvas, DeploySource } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AuditLog } from "../audit/audit-log.js";
import type { DeployEngine } from "../deploy/engine.js";
import { DeployError, type DeployErrorCode, LIMITS } from "../deploy/errors.js";
import type { DeployEntry } from "../deploy/ingest.js";
import type { AppEnv } from "../http/types.js";

/**
 * Reject oversized deploy bodies BEFORE buffering them into memory (the engine's
 * limits only apply after the full body is read). Headroom above the 100 MB
 * canvas cap covers ZIP/multipart overhead. Returns the stable error shape.
 */
export const deployBodyLimit = bodyLimit({
  maxSize: LIMITS.maxCanvasBytes + 10 * 1024 * 1024,
  onError: (c) =>
    c.json({ code: "CANVAS_TOO_LARGE", message: "deploy body exceeds the size limit" }, 413),
});

/**
 * Per-blob body limit for the staging upload channel (plan 003): one blob is one
 * file, so the per-file cap (25 MB) + small framing headroom applies — far tighter
 * than the whole-archive `deployBodyLimit`.
 */
export const blobBodyLimit = bodyLimit({
  maxSize: LIMITS.maxFileBytes + 1024 * 1024,
  onError: (c) =>
    c.json({ code: "FILE_TOO_LARGE", message: "blob exceeds the per-file limit" }, 413),
});

/**
 * Map a stable {@link DeployErrorCode} to its HTTP status (plan 003 F4). The
 * legacy `deployResponse` path keeps its blanket 400; the upload routes use this
 * richer mapping so size caps surface as 413, an invalid/foreign handle as 404
 * (no existence leak), and finalize-lifecycle conflicts as 409.
 */
export function deployErrorStatus(code: DeployErrorCode): 400 | 404 | 409 | 413 {
  switch (code) {
    case "CANVAS_TOO_LARGE":
    case "TOO_MANY_FILES":
    case "FILE_TOO_LARGE":
      return 413;
    case "UPLOAD_HANDLE_INVALID":
      return 404;
    case "UPLOAD_ALREADY_FINALIZED":
    case "UPLOAD_IN_PROGRESS":
      return 409;
    default:
      return 400;
  }
}

/** Render a {@link DeployError} as the stable `{ code, message, path? }` shape at its mapped status. */
export function deployErrorResponse(c: Context<AppEnv>, err: DeployError): Response {
  return c.json({ code: err.code, message: err.message, path: err.path }, deployErrorStatus(err.code));
}

/**
 * Run a deploy and produce the stable machine-readable response (§9.5.4): the
 * success shape `{ url, version, fileCount, totalBytes, warnings }`, or
 * `{ code, message, path? }` on a {@link DeployError}. Shared by the management
 * routes and the Bearer-key API. Audits the deploy with attribution.
 */
export async function deployResponse(
  c: Context<AppEnv>,
  engine: DeployEngine,
  audit: AuditLog,
  canvas: Canvas,
  source: DeploySource,
  entries: AsyncIterable<DeployEntry> | Iterable<DeployEntry>,
  actorId: string,
): Promise<Response> {
  try {
    const result = await engine.deploy(canvas, source, entries, actorId);
    audit.recordAudit({
      action: "deploy",
      actorId,
      targetId: canvas.id,
      meta: { source, version: result.version, fileCount: result.fileCount },
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof DeployError) {
      // All deploy validation errors are 400 — the client must fix the upload.
      return c.json({ code: err.code, message: err.message, path: err.path }, 400);
    }
    throw err;
  }
}

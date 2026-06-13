import type { Canvas, DeploySource } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import type { AuditLog } from "../audit/audit-log.js";
import type { DeployEngine } from "../deploy/engine.js";
import { DeployError } from "../deploy/errors.js";
import type { DeployEntry } from "../deploy/ingest.js";
import type { AppEnv } from "../http/types.js";

/** All deploy validation errors map to 400 — the client must fix the upload. */
function statusForDeployError(_code: string): 400 {
  return 400;
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
      return c.json(
        { code: err.code, message: err.message, path: err.path },
        statusForDeployError(err.code),
      );
    }
    throw err;
  }
}

import type { Canvas } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { AppEnv } from "../http/types.js";

/**
 * Load the canvas named by the `:id` param ONLY if the caller owns it, else null
 * (→ 404, no existence leak). The single owner-only gate for the dashboard's owner
 * management + editor/draft surfaces, shared by management.ts and draft-api.ts so the
 * two security-critical checks can't drift.
 *
 * A non-owner admin is treated like any other member here — it gets the same 404 and
 * cannot view, edit, deploy, configure, or delete someone else's canvas. Cross-owner
 * admin power lives only on the dedicated admin routes (the all-canvases list +
 * disable/enable/restore), never the owner surface (§12.0 #3, D-admin-restrict).
 */
export async function requireOwnedCanvas(
  c: Context<AppEnv>,
  canvases: Pick<CanvasesRepository, "findById">,
): Promise<Canvas | null> {
  const id = c.req.param("id");
  if (!id) return null;
  const cv = await canvases.findById(id);
  if (!cv || cv.status === "deleted") return null;
  if (cv.ownerId !== c.get("user").id) return null;
  return cv;
}

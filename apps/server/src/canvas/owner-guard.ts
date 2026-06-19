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

/**
 * The single, shared error contract for "this owner action is refused because an admin
 * has taken the canvas down" (status === "disabled"). A disabled canvas is **read-only
 * to its owner**: every owner MUTATION (settings, capabilities, slug, preview, access /
 * sharing / guests, tags, deploy / publish / rollback, archive / unpublish, draft edits)
 * rejects with this exact shape, while READS (detail, versions, usage, list) stay allowed
 * so the owner can still see the canvas and the takedown reason.
 *
 * Code is `DISABLED`, HTTP 409 (the row exists and the caller owns it — it isn't a 404
 * existence question, it's a state conflict). The owner-facing `disabledReason` (when an
 * admin set one) is appended so the message itself explains *why*. Used by both the HTTP
 * management/draft routes and the MCP owner-mutation tools so the wording can't drift.
 *
 * Archived is NOT disabled: archive is owner-initiated and reversible, so it keeps its own
 * `NOT_ACTIVE` / `NOT_ARCHIVED` semantics. Deleted stays a 404 (no existence leak). This
 * gate is only for the admin takedown.
 */
export const DISABLED_CODE = "DISABLED" as const;

const DISABLED_BASE_MESSAGE = "This canvas has been disabled by an administrator.";

/** The owner-facing message for a disabled canvas, with the admin's reason appended when set. */
export function disabledMessage(cv: Pick<Canvas, "disabledReason">): string {
  const reason = cv.disabledReason?.trim();
  return reason ? `${DISABLED_BASE_MESSAGE} Reason: ${reason}` : DISABLED_BASE_MESSAGE;
}

/** The `{ code, message }` body for a refused owner mutation on a disabled canvas (HTTP 409). */
export function disabledError(cv: Pick<Canvas, "disabledReason">): {
  code: typeof DISABLED_CODE;
  message: string;
} {
  return { code: DISABLED_CODE, message: disabledMessage(cv) };
}

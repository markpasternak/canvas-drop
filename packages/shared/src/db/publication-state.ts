import type { CanvasStatus } from "./types.js";

/**
 * The single, authoritative lifecycle a reader sees for a canvas. Derived (never
 * stored) from the canvas `status` plus whether a version is currently served,
 * so there is one place this precedence lives and every projection (owner
 * detail, owner list, admin list) stays in lockstep.
 *
 * Precedence: disabled > archived > published > draft. `deleted` is its own
 * value (not folded into `archived`) — owner surfaces filter deleted rows out,
 * but the admin purge view legitimately lists them, so the helper must label a
 * deleted row honestly rather than mask it as archived.
 *
 * NOTE: the dashboard mirrors this exact union in `apps/dashboard/src/lib/api.ts`
 * — keep the two in lockstep when adding a state.
 */
export type PublicationState = "draft" | "published" | "archived" | "disabled" | "deleted";

/** Compute the derived {@link PublicationState}. Total over {@link CanvasStatus}. */
export function publicationState(
  status: CanvasStatus,
  hasCurrentVersion: boolean,
): PublicationState {
  if (status === "deleted") return "deleted";
  if (status === "disabled") return "disabled";
  if (status === "archived") return "archived";
  return hasCurrentVersion ? "published" : "draft";
}

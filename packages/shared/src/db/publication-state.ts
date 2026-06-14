import type { CanvasStatus } from "./types.js";

/**
 * The single, authoritative lifecycle a reader sees for a canvas. Derived (never
 * stored) from the canvas `status` plus whether a version is currently served,
 * so there is one place this precedence lives and every projection (owner
 * detail, owner list, admin list) stays in lockstep.
 *
 * Precedence: disabled > archived > published > draft.
 */
export type PublicationState = "draft" | "published" | "archived" | "disabled";

/**
 * Compute the derived {@link PublicationState}.
 *
 * `deleted` canvases are filtered out before any projection runs, so they are
 * never surfaced; they map to `archived` here only to keep the function total.
 */
export function publicationState(
  status: CanvasStatus,
  hasCurrentVersion: boolean,
): PublicationState {
  if (status === "disabled") return "disabled";
  if (status === "archived" || status === "deleted") return "archived";
  return hasCurrentVersion ? "published" : "draft";
}

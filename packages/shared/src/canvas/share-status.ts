import type { AccessRung } from "../db/types.js";

/**
 * LEGACY. The original derived `status` of a managed authoring share, kept exactly as it
 * was for existing consumers of `canvasdrop.canvases.*`. It conflates two concepts:
 * `private` says the persisted `access` value is literally `"private"` (General access
 * Restricted) — NOT that nobody can open the canvas, since the people-and-teams list
 * applies at every rung — and the legacy aliases `specific_people` / `team` read `live`
 * even though they mean the same audience. New consumers should read the two independent
 * fields instead: `accessMode` ({@link accessModeOf}) for the audience and
 * `publicationStatus` ({@link publicationStatusOf}) for the lifecycle.
 *
 * @deprecated Use `accessMode` + `publicationStatus`; this value is frozen for compatibility.
 */
export type ShareStatus = "live" | "expired" | "revoked" | "private";

/**
 * Derive a share's legacy {@link ShareStatus}. Pure (primitives + `now`). Frozen behaviour:
 * `revoked` (revoked_at set) › `expired` (share expiry has passed) › `private` (the
 * persisted value is exactly `"private"`) › `live`. Do not "fix" the alias asymmetry here —
 * it is documented, and the replacement fields carry the corrected semantics.
 *
 * @deprecated Use {@link accessModeOf} + {@link publicationStatusOf}.
 */
export function shareStatus(
  access: AccessRung | string,
  sharedExpiresAt: number | null,
  revokedAt: number | null,
  now: number,
): ShareStatus {
  if (revokedAt !== null) return "revoked";
  if (sharedExpiresAt !== null && sharedExpiresAt <= now) return "expired";
  if (access === "private") return "private";
  return "live";
}

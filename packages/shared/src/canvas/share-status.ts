import type { AccessRung } from "../db/types.js";

/**
 * The lifecycle status of a managed authoring share (authoring v2), as surfaced to
 * the creator's management UI (`canvasdrop.canvases.list()`). Derived, never stored —
 * one source of truth shared by the server projection and the browser SDK type.
 */
export type ShareStatus = "live" | "expired" | "revoked" | "private";

/**
 * Derive a share's {@link ShareStatus} from its access rung, share expiry, and
 * revoked stamp. Pure (primitives + `now`) so the management projection and any
 * future surface evaluate it identically.
 *
 * Precedence (first match wins): `revoked` (revoked_at set) › `expired` (share
 * expiry has passed) › `private` (the rung is private — not publicly readable) ›
 * `live` (a shareable rung, active, unexpired). Revoked and expired shares are not
 * publicly readable; `private` is owner-only; only `live` is reachable by a reader.
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

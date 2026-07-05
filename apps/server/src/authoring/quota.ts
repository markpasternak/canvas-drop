/**
 * Authoring quota windows (plan 2026-07-04). Per-viewer **daily** (current UTC
 * calendar day; reuse {@link dayStartUtc} from ai/quota) and per-viewer **all-time
 * total**. Pure function of the prior counts so every boundary is unit-testable.
 * Best-effort/check-then-write (TOCTOU accepted on the trusted-org model): overshoot
 * scales with in-flight concurrency, bounded by one authored canvas per allowed call.
 */

export type AuthoringQuotaScope = "user_daily" | "user_total";

export type AuthoringQuotaDecision = { ok: true } | { ok: false; scope: AuthoringQuotaScope };

export interface AuthoringQuotaLimits {
  /** Max canvases a viewer may author per UTC day. */
  dailyMax: number;
  /** Max canvases a viewer may author all-time. */
  totalMax: number;
}

/**
 * Decide whether a new authoring call is allowed given the viewer's prior counts.
 * Rejects when a prior count already **meets or exceeds** its limit. Daily is
 * checked first so its scope wins when both are exhausted.
 */
export function checkAuthoringQuota(
  dailyCount: number,
  totalCount: number,
  limits: AuthoringQuotaLimits,
): AuthoringQuotaDecision {
  if (dailyCount >= limits.dailyMax) return { ok: false, scope: "user_daily" };
  if (totalCount >= limits.totalMax) return { ok: false, scope: "user_total" };
  return { ok: true };
}

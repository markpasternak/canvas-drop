/**
 * AI quota windows (plan 009 / M9, D-AI-4). Per-user **daily** (current UTC
 * calendar day) and per-canvas **monthly** (current UTC calendar month). Pure
 * functions of `now` so every boundary is unit-testable. The check is
 * best-effort/check-then-write (TOCTOU accepted on the trusted-org model):
 * overshoot scales with in-flight concurrency, bounded by the per-call cost cap.
 */

/** Epoch-ms start of the UTC calendar day containing `now`. */
export function dayStartUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Epoch-ms start of the UTC calendar month containing `now`. */
export function monthStartUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export type QuotaScope = "user_daily" | "canvas_monthly";

export type QuotaDecision = { ok: true } | { ok: false; scope: QuotaScope };

export interface QuotaLimits {
  userDailyUsd: number;
  canvasMonthlyUsd: number;
}

/**
 * Decide whether a new call is allowed given prior spend in each window. Rejects
 * when prior spend already **meets or exceeds** the limit (the user has hit it);
 * a sub-limit request is allowed even if it will overshoot (documented TOCTOU).
 * User-daily is checked first so its scope wins when both are exhausted.
 */
export function checkQuota(
  userSpend: number,
  canvasSpend: number,
  limits: QuotaLimits,
): QuotaDecision {
  if (userSpend >= limits.userDailyUsd) return { ok: false, scope: "user_daily" };
  if (canvasSpend >= limits.canvasMonthlyUsd) return { ok: false, scope: "canvas_monthly" };
  return { ok: true };
}

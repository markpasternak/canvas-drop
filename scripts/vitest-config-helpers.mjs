/**
 * Shared helpers for the Vitest configs (root + dashboard).
 *
 * Both configs derive `maxWorkers` and the per-run `cacheDir` from the same two
 * env vars the test-runner sets (`CANVAS_DROP_TEST_MAX_WORKERS`,
 * `CANVAS_DROP_TEST_RUN_ID`). Keeping these in one place stops the two configs
 * from drifting — if the parse logic diverges, the runner's computed worker
 * budget would no longer match what Vitest actually honours.
 *
 * scripts/test-runner.mjs has its own `vitestWorkerValue` / `sanitizeRunId`
 * (used to PRODUCE the env values rather than CONSUME them); those are kept
 * separate on purpose — see the note in test-runner.mjs.
 */

/**
 * Vitest `maxWorkers` from `CANVAS_DROP_TEST_MAX_WORKERS`: a positive integer or
 * a `<n>%` string, else the 50% default.
 *
 * @returns {number | `${number}%`}
 */
export function workerSetting() {
  const raw = process.env.CANVAS_DROP_TEST_MAX_WORKERS?.trim();
  if (!raw) return "50%";
  if (/^[1-9]\d*%$/.test(raw)) return /** @type {`${number}%`} */ (raw);
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : "50%";
}

/**
 * Sanitize a caller-supplied run id for use in a cache-dir name. Returns
 * `undefined` when unset/empty so the config falls back to Vitest's default
 * cache dir.
 *
 * @param {string | undefined} raw
 * @returns {string | undefined}
 */
export function safeRunId(raw) {
  return raw?.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || undefined;
}

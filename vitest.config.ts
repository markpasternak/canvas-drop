import { defineConfig } from "vitest/config";
import { safeRunId, workerSetting } from "./scripts/vitest-config-helpers.mjs";

const runId = safeRunId(process.env.CANVAS_DROP_TEST_RUN_ID);

export default defineConfig({
  cacheDir: runId ? `node_modules/.vite/vitest-${runId}-root` : undefined,
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts", "scripts/*.test.mjs"],
    environment: "node",
    passWithNoTests: true,
    // The dual-dialect suite runs both legs in one process: every DB test spins its
    // own in-process pglite (WASM Postgres) across parallel worker threads. Under CPU
    // contention (a concurrent build, many workers) a single pglite query can blow
    // past vitest's 5s default and get killed mid-flight — a flaky resource timeout,
    // not a real hang (clean re-runs pass). A 20s ceiling absorbs the spike while still
    // failing a genuine hang. makeTestDb runs in the test body, so testTimeout covers it.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Run on every core. The test-runner sets CANVAS_DROP_TEST_MAX_WORKERS to a
    // full-core budget for a solo run (and splits it across concurrent runs); a
    // bare `vitest` falls back to 100%. The in-process pglite legs are CPU-bound,
    // so one worker per core is the sweet spot — it's measurably faster than the
    // old half-core cap on every leg and stays green, with the 20s ceiling above
    // absorbing the occasional contention spike rather than the cap fighting it.
    // Override with CANVAS_DROP_TEST_MAX_WORKERS or `--maxWorkers` to throttle.
    maxWorkers: workerSetting(),
  },
});

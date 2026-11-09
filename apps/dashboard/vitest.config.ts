import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { safeRunId, workerSetting } from "../../scripts/vitest-config-helpers.mjs";

const runId = safeRunId(process.env.CANVAS_DROP_TEST_RUN_ID);

// Workspace-scoped: the dashboard's React tests run in jsdom. The repo root
// vitest config (node env, dual-dialect server suite) is left entirely untouched
// so the SQLite/Postgres dialect split is never at risk (area E, KTD-7).
export default defineConfig({
  plugins: [react()],
  cacheDir: runId ? `node_modules/.vite/vitest-${runId}-dashboard` : undefined,
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.tsx"],
    css: false,
    // setup.ts lets a single findBy/waitFor wait up to 5s for lazy route chunks
    // under load, so the per-test budget must sit well above that. With
    // Vitest's 5s default, multi-step router tests (new.test.tsx) passed in
    // ~0.4s idle but timed out on loaded CI runners.
    testTimeout: 20_000,
    maxWorkers: workerSetting(),
  },
});

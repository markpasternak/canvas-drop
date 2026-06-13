import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
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
  },
});

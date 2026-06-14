import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

function workerSetting(): number | `${number}%` {
  const raw = process.env.CANVAS_DROP_TEST_MAX_WORKERS?.trim();
  if (!raw) return "50%";
  if (/^[1-9]\d*%$/.test(raw)) return raw as `${number}%`;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : "50%";
}

function safeRunId(raw: string | undefined): string | undefined {
  return raw?.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || undefined;
}

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
    maxWorkers: workerSetting(),
  },
});

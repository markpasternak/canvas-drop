import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Workspace-scoped: the dashboard's React tests run in jsdom. The repo root
// vitest config (node env, dual-dialect server suite) is left entirely untouched
// so the SQLite/Postgres dialect split is never at risk (area E, KTD-7).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.tsx"],
    css: false,
  },
});

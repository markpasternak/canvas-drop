import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard SPA. In dev, Vite serves with HMR on :5173 and proxies the API,
// auth, and Bearer-deploy paths to the Hono server (:3000). In prod, `vite build`
// emits hashed assets to dist/ which the Hono process serves (area E, U3).
//
// Dev-server-only knobs (ignored by `vite build`, so they never touch the prod
// deploy): the dashboard port and the proxy target are env-overridable so several
// agents can run fully isolated dev instances in parallel. Each agent sets its own
// backend on CANVAS_DROP_PORT and its dashboard on CANVAS_DROP_DASHBOARD_PORT, with
// the proxy pointed at THAT agent's backend. Unset → the original 5173/:3000
// defaults, so a plain `pnpm dev` behaves exactly as before.
const DASHBOARD_PORT = Number(process.env.CANVAS_DROP_DASHBOARD_PORT) || 5173;
const API_TARGET = `http://localhost:${Number(process.env.CANVAS_DROP_PORT) || 3000}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    // Hashed filenames → immutable caching; index.html stays no-cache (U3).
    sourcemap: true,
  },
  server: {
    port: DASHBOARD_PORT,
    // Fail loudly if the port is taken instead of silently hopping to the next one
    // — a surprise port usually means a stale dev server (or another project) is
    // still running, which is exactly what you want to know about.
    strictPort: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: false },
      "/auth": { target: API_TARGET, changeOrigin: false },
      "/v1": { target: API_TARGET, changeOrigin: false },
    },
  },
});

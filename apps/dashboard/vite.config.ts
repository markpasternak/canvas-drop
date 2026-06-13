import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard SPA. In dev, Vite serves with HMR on :5173 and proxies the API,
// auth, and Bearer-deploy paths to the Hono server (:3000). In prod, `vite build`
// emits hashed assets to dist/ which the Hono process serves (area E, U3).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    // Hashed filenames → immutable caching; index.html stays no-cache (U3).
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Fail loudly if 5173 is taken instead of silently hopping to 5174 — a
    // surprise port usually means a stale dev server (or another project) is
    // still running, which is exactly what you want to know about.
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: false },
      "/auth": { target: "http://localhost:3000", changeOrigin: false },
      "/v1": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
});

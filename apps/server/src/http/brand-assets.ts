import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { baseSecurityHeaders } from "./security-headers.js";
import type { AppEnv } from "./types.js";

/**
 * Public favicon / brand icons, served BEFORE the auth gateway.
 *
 * The dashboard SPA references these at the root (`/favicon.svg`, etc.) and Vite
 * copies them from `apps/dashboard/public/` into the SPA bundle — but the SPA sits
 * behind the gateway, so an unauthenticated icon request (every signed-out page:
 * the landing, legal, docs, and link crawlers) was 302-redirected to login and no
 * icon loaded. Mounting these pre-gateway (next to `/og.png`, `/privacy`, `/docs`)
 * makes the icon resolve for everyone. The filenames are an explicit allowlist with
 * fixed content-types; a missing file is a plain 404.
 *
 * `apps/dashboard/public/` is the single source (the SPA uses the same files), so
 * there is no duplicate copy to drift. Resolved repo-relative to this module so it
 * works from both `src/` (dev/test) and `dist/` (prod).
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PUBLIC_DIR = join(REPO_ROOT, "apps/dashboard/public");

const ASSETS: Record<string, { file: string; type: string }> = {
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
  "/favicon-32x32.png": { file: "favicon-32x32.png", type: "image/png" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
  "/site.webmanifest": { file: "site.webmanifest", type: "application/manifest+json" },
  // Icons referenced by site.webmanifest — also public so an installed PWA resolves them.
  "/brand/canvasdrop-mark.svg": { file: "brand/canvasdrop-mark.svg", type: "image/svg+xml" },
  "/brand/canvasdrop-mark-192.png": { file: "brand/canvasdrop-mark-192.png", type: "image/png" },
  "/brand/canvasdrop-mark-512.png": { file: "brand/canvasdrop-mark-512.png", type: "image/png" },
  "/brand/canvasdrop-logo.svg": { file: "brand/canvasdrop-logo.svg", type: "image/svg+xml" },
};

export function brandAssetRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  for (const [route, { file, type }] of Object.entries(ASSETS)) {
    app.get(route, async (c) => {
      try {
        const bytes = await readFile(join(PUBLIC_DIR, file));
        const headers = new Headers();
        baseSecurityHeaders(headers);
        headers.set("Content-Type", type);
        headers.set("Cache-Control", "public, max-age=86400");
        return new Response(bytes, { status: 200, headers });
      } catch {
        return c.notFound();
      }
    });
  }
  return app;
}

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

/**
 * Self-hosted Newsreader (the editorial serif) for the server-rendered, pre-gateway
 * pages (the signed-out landing, legal, error pages). Those pages can't use the SPA's
 * bundled fonts — they sit before the auth gateway and ship no Vite bundle — so the
 * serif (`--font-serif`) would otherwise fall back to a system serif. canvas-drop never
 * phones home, so we serve the woff2 ourselves rather than pulling from a CDN.
 *
 * The files come from `@fontsource-variable/newsreader` (a workspace dep; OFL-licensed,
 * free to self-serve), resolved through Node module resolution so the path is correct
 * from both `src/` (dev/test) and `dist/` (prod) regardless of the pnpm store layout.
 * Both are variable-weight (200–800) over the Latin subset — the landing is English —
 * one normal, one italic (the hero's italic-accent clause). `format('woff2-variations')`
 * + `font-weight: 200 800` in the page `@font-face` matches the fontsource definitions.
 */
const FONTS: Record<string, string> = {
  "/fonts/newsreader-latin-wght-normal.woff2": "newsreader-latin-wght-normal.woff2",
  "/fonts/newsreader-latin-standard-italic.woff2": "newsreader-latin-standard-italic.woff2",
};

/** Absolute path to a Newsreader woff2 inside the resolved package `files/` dir.
 *  Resolved via Node's real module resolver (`createRequire`) so it is correct from
 *  both `src/` and `dist/` and across the pnpm store layout — and unaffected by the
 *  test bundler's `import.meta.resolve` override. */
const requireFont = createRequire(import.meta.url);
function fontPath(file: string): string {
  return requireFont.resolve(`@fontsource-variable/newsreader/files/${file}`);
}

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
  // Self-hosted Newsreader woff2 (immutable, content-stable filenames → 1-year cache).
  for (const [route, file] of Object.entries(FONTS)) {
    app.get(route, async (c) => {
      try {
        const bytes = await readFile(fontPath(file));
        const headers = new Headers();
        baseSecurityHeaders(headers);
        headers.set("Content-Type", "font/woff2");
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        return new Response(bytes, { status: 200, headers });
      } catch {
        return c.notFound();
      }
    });
  }
  return app;
}

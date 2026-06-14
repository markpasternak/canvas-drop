import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@canvas-drop/shared";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { mimeFor } from "../canvas/mime.js";
import { errorResponse } from "../http/error-pages.js";
import type { AppEnv } from "../http/types.js";
import type { Logger } from "../log/logger.js";

/**
 * Resolve the built dashboard `dist/`. Default is relative to THIS module (so a
 * packaged `node apps/server/dist/index.js` run from any cwd finds it), not a
 * cwd walk-up. `CANVAS_DROP_DASHBOARD_DIST` overrides for non-standard layouts.
 * Both `apps/server/src/dashboard` and `apps/server/dist/dashboard` sit three
 * levels under `apps/`, so the same relative path works in dev, tests, and prod.
 */
function resolveDistDir(config: Config): string {
  if (config.dashboardDist) return resolve(config.dashboardDist);
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../dashboard/dist");
}

/**
 * Strict Content-Security-Policy + security headers for the dashboard document
 * (§12.4). The SPA emits external, hashed scripts/styles (Vite) and self-hosted
 * fonts — so everything is `'self'`. NOTE: this governs the dashboard document,
 * not canvas documents; in path mode the canvas→management residual is handled by
 * `Sec-Fetch-Site` + `SameSite` cookies (§12.2), not by this CSP.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

async function read(path: string, log?: Logger): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (err) {
    // A missing file is the normal not-found / history-fallback path. Anything
    // else (EACCES, EISDIR on a weird request, ENOMEM) is worth an operator's
    // attention — don't swallow it silently.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.warn({ err, path }, "serveSpa: unexpected asset read error");
    }
    return null;
  }
}

/**
 * Serve the built dashboard SPA for the `dashboard` role (area E, U3). Mounted at
 * the post-gateway catch-all (NOT before the gateway), so every asset is served
 * only to an authenticated org member — login-on-every-request holds for the SPA
 * shell itself (§12.1.1). Real hashed assets get an immutable cache; the SPA
 * history fallback serves `index.html` (no-cache) so deploys are instantly live.
 */
export function serveSpa(deps: { config: Config; log?: Logger }) {
  const distDir = resolveDistDir(deps.config);
  const indexPath = join(distDir, "index.html");
  const log = deps.log;

  function indexResponse(c: Context<AppEnv>, body: Uint8Array) {
    const headers = new Headers(SECURITY_HEADERS);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-cache");
    // biome-ignore lint/suspicious/noExplicitAny: BodyInit accepts Uint8Array at runtime
    return c.body(body as any, 200, Object.fromEntries(headers));
  }

  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();

    // A malformed percent-encoding must not 500 — treat it as a shell request.
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      pathname = "/";
    }
    const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const candidate = join(distDir, rel);

    // Path-traversal guard: the resolved file must stay within distDir.
    const within = candidate === distDir || candidate.startsWith(distDir + sep);
    const isFileReq = within && rel !== "/" && !rel.endsWith("/");
    // Vite emits content-hashed, immutable filenames under /assets/.
    const isHashedAsset = rel.startsWith("/assets/");

    const fileBody = isFileReq ? await read(candidate, log) : null;
    if (fileBody !== null) {
      const headers = new Headers(SECURITY_HEADERS);
      headers.set("Content-Type", mimeFor(candidate).contentType);
      headers.set(
        "Cache-Control",
        isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      );
      // biome-ignore lint/suspicious/noExplicitAny: BodyInit accepts Uint8Array at runtime
      return c.body(fileBody as any, 200, Object.fromEntries(headers));
    }

    // A missing hashed asset must 404, NOT fall back to the HTML shell — a stale
    // lazy-route chunk requested across a redeploy then fails cleanly (and with
    // nosniff the browser won't execute HTML as a module) instead of silently
    // serving index.html with a 200.
    if (isHashedAsset) {
      return errorResponse(
        c,
        {
          status: 404,
          code: "not_found",
          title: "Asset not found",
          message: "This dashboard asset is no longer available. Refresh the page and try again.",
        },
        { error: "not_found" },
        { "Cache-Control": "no-store" },
      );
    }

    // History fallback → index.html (SPA routing).
    const index = await read(indexPath, log);
    if (index === null) {
      // The SPA isn't built (dev runs it via Vite; prod must `pnpm build`).
      log?.warn(
        { distDir, indexPath },
        "serveSpa: dashboard index.html not found — is the SPA built? (pnpm build)",
      );
      return errorResponse(
        c,
        {
          status: 503,
          code: "dashboard_not_built",
          title: "Dashboard not built",
          message: "dashboard dist not found",
          hint: "Run pnpm build before starting the production server.",
        },
        { error: "dashboard_not_built", message: "dashboard dist not found" },
        { "Cache-Control": "no-store" },
      );
    }
    return indexResponse(c, index);
  });
}

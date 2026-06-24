import type { Config } from "@canvas-drop/shared";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./types.js";

/**
 * The §12.4 baseline security headers, applied to EVERY response surface (M7).
 * The single source of truth so a new surface can't ship without them.
 *
 * Two application paths, because Hono handlers that build their OWN `Response`/
 * `c.body(...)` with an explicit `Headers` object do not merge an outer
 * middleware's `c.header(...)`:
 *
 *  - **Self-Response handlers** (canvas serve, file serving, SPA shell, draft
 *    preview, disabled page, 404, the browser SDK at `/sdk/v1.js`, and the Bearer
 *    deploy read-back `GET /v1/canvases/:id/files`) call {@link baseSecurityHeaders}
 *    on their own `Headers` and layer their stricter CSP/frame-ancestors on top.
 *  - **JSON API responses** (`c.json` — management, admin, runtime, me) inherit
 *    the baseline from {@link securityHeadersMiddleware}, which previously had no
 *    baseline at all.
 *
 * COOP is included: it was already on the SPA document but absent from canvas
 * content and the JSON API — this closes those gaps (audit, M7).
 */
export function baseSecurityHeaders(headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
}

/**
 * `frame-ancestors` value for canvas content. In subdomain mode each canvas is
 * its own origin, so the dashboard (the apex baseUrl) must be listed explicitly
 * alongside 'self' so the dashboard can embed canvases in an iframe. In path
 * mode every canvas shares the dashboard origin, so 'self' already covers it.
 */
export function canvasFrameAncestors(config: Config): string {
  if (config.urlMode === "subdomain") {
    return `frame-ancestors 'self' ${new URL(config.baseUrl).origin}`;
  }
  return "frame-ancestors 'self'";
}

/**
 * Fallback baseline for `c.json`/`c.text` API responses (those that DON'T build
 * their own `Headers`). Set before `next()` so the handler's response inherits
 * them. Self-Response surfaces call {@link baseSecurityHeaders} directly instead.
 */
export function securityHeadersMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    await next();
  });
}

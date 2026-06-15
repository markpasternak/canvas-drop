import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { canvasUrl } from "../canvas/url.js";
import type { AppEnv } from "./types.js";

/**
 * The canvas resolved by the runtime router's resolve middleware. Throws if a
 * handler runs without it (a wiring error — every primitive route is mounted
 * behind the resolver). Shared by the kv/files/me handlers (avoids per-file dupes).
 */
export function requireCanvas(c: Context<AppEnv>): Canvas {
  const cv = c.get("canvas");
  if (!cv) throw new Error("canvas not resolved — runtime router resolve middleware did not run");
  return cv;
}

/**
 * Cross-canvas isolation for the `/v1/c/:slug/*` runtime API (§12.0 #4, §9.4).
 *
 * Subdomain mode: a canvas page's `Origin` is `https://{slug}.{base}`. We require
 * the request Origin to match the slug in the path, and emit credentialed CORS so
 * the SDK (loaded on the canvas subdomain) can call the base-host API. A request
 * from canvas B's origin to canvas A's API is rejected.
 *
 * Path mode (one shared origin): Origin can't distinguish canvases, so we fall
 * back to the best-effort `Sec-Fetch-Site` + `Referer` checks §12.2 specifies —
 * documented as reduced isolation.
 */

/** The Origin a canvas's own page is served from, or null in path mode. */
export function expectedCanvasOrigin(config: Config, slug: string): string | null {
  if (config.urlMode !== "subdomain") return null;
  return new URL(canvasUrl(config, slug)).origin;
}

export function applyCors(c: Context<AppEnv>, origin: string): void {
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Vary", "Origin");
}

/**
 * Pre-gateway CORS preflight handler for `OPTIONS /v1/c/:slug/*`. Preflights carry
 * no credentials, so they must be answered BEFORE the auth gateway. Subdomain mode
 * echoes the validated canvas origin; path mode just 204s (same-origin, no CORS).
 */
export function canvasApiPreflight(config: Config) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.method !== "OPTIONS") return next();
    const slug = c.req.param("slug");
    const origin = c.req.header("origin");
    const expected = slug ? expectedCanvasOrigin(config, slug) : null;
    if (expected && origin === expected) applyCors(c, origin);
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    return c.body(null, 204);
  });
}

/**
 * Post-resolve isolation middleware. Runs after the canvas is resolved into
 * `c.get("canvas")`; rejects cross-canvas calls and applies CORS to the real
 * response. Reads the slug from the resolved canvas (authoritative).
 */
export function canvasApiIsolation(config: Config) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const slug = c.get("canvas")?.slug ?? c.req.param("slug");
    if (config.urlMode === "subdomain") {
      const expected = slug ? expectedCanvasOrigin(config, slug) : null;
      const origin = c.req.header("origin");
      // A browser request carries Origin; it must match this canvas. No Origin =
      // a non-browser/programmatic caller (no ambient cross-canvas authority).
      if (origin) {
        if (!expected || origin !== expected) {
          return c.json({ code: "CROSS_CANVAS_FORBIDDEN" }, 403);
        }
        applyCors(c, origin);
      }
    } else {
      // Path mode: best-effort per §12.2 (reduced isolation, documented).
      const sfs = c.req.header("sec-fetch-site");
      if (sfs && sfs !== "same-origin" && sfs !== "none") {
        return c.json({ code: "CROSS_SITE_FORBIDDEN" }, 403);
      }
      const referer = c.req.header("referer");
      if (referer && slug) {
        try {
          const path = new URL(referer).pathname;
          // Segment-boundary match (NOT substring): `/c/app` must not satisfy a
          // request for slug `ap`, and slug `app` must not be satisfied by a
          // referer for `/c/app-evil`.
          const onThisCanvas = path === `/c/${slug}` || path.startsWith(`/c/${slug}/`);
          if (!onThisCanvas) {
            return c.json({ code: "CROSS_CANVAS_FORBIDDEN" }, 403);
          }
        } catch {
          // unparseable Referer → ignore (best-effort)
        }
      }
    }
    await next();
  });
}

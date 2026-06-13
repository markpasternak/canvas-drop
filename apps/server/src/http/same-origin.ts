import type { Config } from "@canvas-drop/shared";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./types.js";

/**
 * Same-origin guard for state-changing management routes (§9.2). The management
 * API is reachable only from the dashboard's own origin; a cross-site request is
 * rejected. Uses `Sec-Fetch-Site` (set by browsers, not forgeable from JS) with
 * an `Origin`-host fallback. Non-browser clients (no Sec-Fetch-Site, no Origin)
 * are allowed — they are the programmatic Bearer-key API's concern, not this.
 */
export function requireSameOrigin(config: Config) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!isSameOrigin(c, config)) {
      return c.json({ error: "cross_origin_forbidden" }, 403);
    }
    await next();
  });
}

export function isSameOrigin(c: Context<AppEnv>, config: Config): boolean {
  const secFetchSite = c.req.header("sec-fetch-site");
  if (secFetchSite) {
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }
  const origin = c.req.header("origin");
  if (origin) {
    try {
      return new URL(origin).host === new URL(config.baseUrl).host;
    } catch {
      return false;
    }
  }
  // No browser fetch-metadata and no Origin → not a browser cross-site request.
  return true;
}

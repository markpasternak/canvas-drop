import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { baseSecurityHeaders } from "../http/security-headers.js";
import type { AppEnv } from "../http/types.js";

/**
 * Serves the built browser SDK at `GET /sdk/v1.js` (BUILD_BRIEF §11.1). Mounted
 * BEHIND the auth gateway (§12.0 #1 — login on every request includes the SDK
 * script). The bundle is produced by `@canvas-drop/sdk`'s esbuild `build` step;
 * the stable `/sdk/v1.js` path is additive/back-compat within v1 so deployed
 * canvases receive fixes (KTD-6). In dev before a build, a 503 explains how to fix.
 */

/** Resolve the built bundle path via the sdk package's `./bundle` export, or null. */
export function defaultBundlePath(): string | null {
  try {
    return createRequire(import.meta.url).resolve("@canvas-drop/sdk/bundle");
  } catch {
    return null;
  }
}

export interface ServeSdkOptions {
  /** Override for tests; defaults to reading the resolved dist bundle once. */
  loadBundle?: () => string | null;
}

export function serveSdkRoutes(opts: ServeSdkOptions = {}): Hono<AppEnv> {
  const load =
    opts.loadBundle ??
    (() => {
      const path = defaultBundlePath();
      return path ? readFileSync(path, "utf8") : null;
    });
  // Only a successful (string) load is cached. A failed load stays uncached so a
  // build completed while the server is live is picked up on the next request
  // (no restart needed) — and a partial first-request never sticks.
  let cached: string | undefined;

  const app = new Hono<AppEnv>();
  app.get("/sdk/v1.js", (c) => {
    if (cached === undefined) cached = load() ?? undefined;
    if (!cached) {
      return c.text(
        "SDK bundle not built — run `pnpm build` (or `pnpm --filter @canvas-drop/sdk build`).",
        503,
      );
    }
    const headers = new Headers();
    baseSecurityHeaders(headers);
    headers.set("content-type", "application/javascript; charset=utf-8");
    headers.set("cache-control", "public, max-age=3600");
    return new Response(cached, { headers });
  });

  // NOTE: `/llms.txt` is no longer served here. It moved to the PUBLIC docs band
  // (apps/server/src/docs/routes.ts, mounted before the gateway) so agents can
  // read it without a session — see plan U4. `/sdk/v1.js` stays behind the gateway.

  return app;
}

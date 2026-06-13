import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";
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
  let cached: string | null | undefined;

  const app = new Hono<AppEnv>();
  app.get("/sdk/v1.js", (c) => {
    if (cached === undefined) cached = load();
    if (!cached) {
      return c.text(
        "SDK bundle not built — run `pnpm build` (or `pnpm --filter @canvas-drop/sdk build`).",
        503,
      );
    }
    return new Response(cached, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  });
  return app;
}

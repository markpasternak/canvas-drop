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

/**
 * Agent-facing SDK reference served at `GET /llms.txt` (BUILD_BRIEF §11.1).
 * Embedded as a string so it ships with the compiled server (no file copy step)
 * and stays in lockstep with the SDK shape.
 */
export const LLMS_TXT = `# canvas-drop SDK (llms.txt)

Add to a canvas (one tag, no build step):
  <script src="/sdk/v1.js"></script>

The global \`canvasdrop\` is then available. Identity rides the signed-in session;
canvas code carries NO secrets. A method throws if its capability is off
(\`CapabilityDisabledError\`), so the canvas owner must enable Backend + the feature
in the Capabilities tab.

Identity:
  const me = await canvasdrop.me(); // { id, email, name, avatarUrl }

KV (shared, canvas-global):
  await canvasdrop.kv.set("votes", 0);
  const n = await canvasdrop.kv.get("votes");      // value or null
  const total = await canvasdrop.kv.increment("votes", 1); // atomic; polls/counters
  await canvasdrop.kv.delete("votes");
  const page = await canvasdrop.kv.list({ prefix: "p:", limit: 100 }); // { entries, nextCursor }

KV (per-viewer, auto-scoped to the signed-in user):
  await canvasdrop.kv.user.set("pref", "dark");
  const pref = await canvasdrop.kv.user.get("pref");

Files:
  const f = await canvasdrop.files.upload(fileInput.files[0]); // { id, name, size, url }
  const all = await canvasdrop.files.list();
  const href = canvasdrop.files.url(f.id); // same-origin content URL (use in <img>/<a>)
  await canvasdrop.files.delete(f.id);

Limits: KV value <= 64 KB, key <= 512 bytes, 10k keys/canvas (1k per user). Files
<= 25 MB/file, 1 GB/canvas. Uploaded files download as attachments (SVG/HTML are
never served inline).

Errors (all extend CanvasdropError, carry .code + .status):
  CapabilityDisabledError (403), QuotaExceededError (409/413), NotFoundError (404),
  NotAuthenticatedError (401).
`;

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

  // Agent-facing SDK reference (behind the gateway, like the script).
  app.get("/llms.txt", (c) => c.text(LLMS_TXT, 200, { "cache-control": "public, max-age=3600" }));

  return app;
}

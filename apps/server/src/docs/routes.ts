import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { errorResponse } from "../http/error-pages.js";
import { baseSecurityHeaders } from "../http/security-headers.js";
import type { AppEnv } from "../http/types.js";
import { LLMS_TXT, SEARCH_INDEX } from "./generated-content.js";
import { renderDocPage } from "./render.js";
import { SEARCH_CLIENT_JS } from "./search.client.js";

/**
 * Public docs router — mounted at "/" BEFORE the auth gateway (see app.ts), so
 * `/docs/*` and `/llms.txt` are served to signed-out agents and OSS browsers on
 * every host. All responses are static, author-controlled content (no identity),
 * so the §12 invariants are unaffected. The docs CSP is `script-src 'self';
 * frame-ancestors 'none'` because the only script is the served `/docs/search.js`.
 */

const ASSETS_DIR = join(process.cwd(), "docs/site/assets");
const ASSET_NAME = /^[a-z0-9][a-z0-9-]*\.webp$/;

function htmlHeaders(): Headers {
  const h = new Headers();
  baseSecurityHeaders(h);
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Content-Security-Policy", "script-src 'self'; frame-ancestors 'none'");
  h.set("Cache-Control", "public, max-age=3600");
  return h;
}

export function docsRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Served search client (kept ahead of the catch-all doc route).
  app.get("/docs/search.js", () => {
    const h = new Headers();
    baseSecurityHeaders(h);
    h.set("Content-Type", "application/javascript; charset=utf-8");
    h.set("Cache-Control", "public, max-age=3600");
    return new Response(SEARCH_CLIENT_JS, { status: 200, headers: h });
  });

  app.get("/docs/search-index.json", () => {
    const h = new Headers();
    baseSecurityHeaders(h);
    h.set("Content-Type", "application/json; charset=utf-8");
    h.set("Cache-Control", "public, max-age=3600");
    return new Response(JSON.stringify(SEARCH_INDEX), { status: 200, headers: h });
  });

  // Optimized screenshot assets. Filenames are allow-listed (no traversal); a
  // missing asset is a plain 404. (Assets are committed by the screenshot pipeline.)
  app.get("/docs/assets/:file", async (c) => {
    const file = c.req.param("file");
    if (!ASSET_NAME.test(file)) return c.notFound();
    try {
      const bytes = await readFile(join(ASSETS_DIR, file));
      const h = new Headers();
      baseSecurityHeaders(h);
      h.set("Content-Type", "image/webp");
      h.set("Cache-Control", "public, max-age=86400");
      return new Response(bytes, { status: 200, headers: h });
    } catch {
      return c.notFound();
    }
  });

  // Agent-optimized single file (U4). Public; converges the formerly-private
  // /llms.txt that lived behind the gateway in serve-sdk.ts.
  app.get("/llms.txt", () => {
    const h = new Headers();
    baseSecurityHeaders(h);
    h.set("Content-Type", "text/plain; charset=utf-8");
    h.set("Cache-Control", "public, max-age=3600");
    return new Response(LLMS_TXT, { status: 200, headers: h });
  });

  // Docs index.
  app.get("/docs", (c) => docPage(c, ""));
  // Any nested doc path (e.g. /docs/sdk/kv). Static routes above take priority.
  app.get("/docs/:path{.+}", (c) => docPage(c, c.req.param("path")));

  return app;
}

function docPage(c: import("hono").Context<AppEnv>, path: string): Response {
  const html = renderDocPage(path);
  if (html === null) {
    return errorResponse(
      c,
      {
        status: 404,
        code: "not_found",
        title: "Page not found",
        message: "There is no documentation page at this address.",
        actionHref: "/docs",
        actionLabel: "Open docs",
      },
      { error: "not_found" },
    );
  }
  return new Response(html, { status: 200, headers: htmlHeaders() });
}

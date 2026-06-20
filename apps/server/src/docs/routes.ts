import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, SkinName } from "@canvas-drop/shared";
import { zipSync } from "fflate";
import { Hono } from "hono";
import { errorResponse } from "../http/error-pages.js";
import { baseSecurityHeaders } from "../http/security-headers.js";
import type { AppEnv } from "../http/types.js";
import { LLMS_TXT, SEARCH_INDEX } from "./generated-content.js";
import { renderDocPage } from "./render.js";
import { SEARCH_CLIENT_JS } from "./search.client.js";
import { THEME_CLIENT_JS } from "./theme.client.js";

/** SEARCH_INDEX is a module-level constant — serialize it once, not per request. */
const SEARCH_INDEX_JSON = JSON.stringify(SEARCH_INDEX);

/**
 * Public docs router — mounted at "/" BEFORE the auth gateway (see app.ts), so
 * `/docs/*` and `/llms.txt` are served to signed-out agents and OSS browsers on
 * every host. All responses are static, author-controlled content (no identity),
 * so the §12 invariants are unaffected. The docs CSP is `script-src 'self';
 * frame-ancestors 'none'` because the only scripts are the served, same-origin
 * `/docs/search.js` and `/docs/theme.js`.
 */

// Resolve repo-relative content dirs from THIS module (apps/server/src|dist/docs),
// not process.cwd() — the dev server runs with cwd=apps/server, and a compiled
// server's cwd is unknown. Both src/ and dist/ sit two levels under apps/server,
// so "../../../.." reaches the repo root in either layout. (Deploys must ship
// docs/site/assets + skill/ alongside the server.)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ASSETS_DIR = join(REPO_ROOT, "docs/site/assets");
const ASSET_NAME = /^[a-z0-9][a-z0-9-]*\.webp$/;
const SKILL_DIR = join(REPO_ROOT, "skill/canvas-drop");
/** The committed social share card (`pnpm og:build`), served publicly at /og.png. */
const OG_IMAGE = join(REPO_ROOT, "docs/site/og.png");

/**
 * Build the agent-skill zip in-process from an EXPLICIT allowlist — `SKILL.md`
 * plus `examples/*.md` only — never a recursive directory glob, so a stray
 * secret file can never be served. Memoized at first request. Uses fflate
 * (already a server dependency) — no build artifact, no committed binary.
 */
let skillZipCache: Uint8Array | null = null;

export function buildSkillZip(): Uint8Array | null {
  // Memoize only the SUCCESS path: a transient FS error must not pin /skill.zip
  // to 404 for the process lifetime (a later request can retry).
  if (skillZipCache) return skillZipCache;

  let skillMd: Uint8Array;
  try {
    skillMd = readFileSync(join(SKILL_DIR, "SKILL.md"));
  } catch {
    return null; // SKILL.md is required; without it there is no skill to serve.
  }

  const files: Record<string, Uint8Array> = { "canvas-drop/SKILL.md": skillMd };
  // Examples are best-effort: a missing examples/ dir still yields a valid zip
  // with SKILL.md alone. Allowlist: only markdown files (never a recursive glob).
  try {
    for (const name of readdirSync(join(SKILL_DIR, "examples"))) {
      if (!name.endsWith(".md")) continue;
      files[`canvas-drop/examples/${name}`] = readFileSync(join(SKILL_DIR, "examples", name));
    }
  } catch {
    // no examples/ dir — serve SKILL.md only
  }

  skillZipCache = zipSync(files);
  return skillZipCache;
}

function htmlHeaders(): Headers {
  const h = new Headers();
  baseSecurityHeaders(h);
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Content-Security-Policy", "script-src 'self'; frame-ancestors 'none'");
  h.set("Cache-Control", "public, max-age=3600");
  return h;
}

/**
 * Public docs router. `opts.skin` resolves the effective instance design skin
 * per-request (admin DB override over env/default), threaded in from `app.ts` the
 * same way the landing page is wired — so the docs "wear" the active skin exactly
 * like the marketing surface. Default editorial (the attribute-free base) when no
 * resolver is supplied (tests / mounts that don't care).
 */
export function docsRoutes(
  config: Config,
  opts: { skin?: () => Promise<SkinName> } = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Public base URL → absolute og:image / og:url (social crawlers require absolute).
  const origin = config.baseUrl;
  const resolveSkin = opts.skin ?? (async () => "editorial" as const);

  // Pre-build the skill zip at mount time so the first /skill.zip request doesn't
  // block the event loop on synchronous readFileSync/readdirSync/zipSync work.
  // (Memoized in buildSkillZip; a transient FS miss here is retried on first request.)
  buildSkillZip();

  // Social share card (`pnpm og:build`). Public so crawlers can fetch the image —
  // the auth-gated SPA can't serve it to an unauthenticated unfurl. A missing file
  // (deploy didn't ship docs/site/og.png) is a plain 404.
  app.get("/og.png", async (c) => {
    try {
      const bytes = await readFile(OG_IMAGE);
      const h = new Headers();
      baseSecurityHeaders(h);
      h.set("Content-Type", "image/png");
      h.set("Cache-Control", "public, max-age=86400");
      return new Response(bytes, { status: 200, headers: h });
    } catch {
      return c.notFound();
    }
  });

  // Served search client (kept ahead of the catch-all doc route).
  app.get("/docs/search.js", () => {
    const h = new Headers();
    baseSecurityHeaders(h);
    h.set("Content-Type", "application/javascript; charset=utf-8");
    h.set("Cache-Control", "public, max-age=3600");
    return new Response(SEARCH_CLIENT_JS, { status: 200, headers: h });
  });

  // Served theme client — loaded from <head> so the persisted theme applies
  // before first paint. Shares the dashboard's data-theme + canvas-drop-theme key.
  app.get("/docs/theme.js", () => {
    const h = new Headers();
    baseSecurityHeaders(h);
    h.set("Content-Type", "application/javascript; charset=utf-8");
    h.set("Cache-Control", "public, max-age=3600");
    return new Response(THEME_CLIENT_JS, { status: 200, headers: h });
  });

  app.get("/docs/search-index.json", () => {
    const h = new Headers();
    baseSecurityHeaders(h);
    h.set("Content-Type", "application/json; charset=utf-8");
    h.set("Cache-Control", "public, max-age=3600");
    return new Response(SEARCH_INDEX_JSON, { status: 200, headers: h });
  });

  // Self-hosted Mermaid renderer (`pnpm docs:mermaid` → docs/site/assets/mermaid.js),
  // served same-origin so the docs CSP stays `script-src 'self'` (a CDN would violate
  // it and the no-phone-home rule). Loaded `defer` only on pages with a diagram. The
  // bundle is ~3MB → long-cache immutable; a missing file is a JS-comment 404.
  app.get("/docs/mermaid.js", async () => {
    const h = new Headers();
    baseSecurityHeaders(h);
    h.set("Content-Type", "application/javascript; charset=utf-8");
    h.set("Cache-Control", "public, max-age=31536000, immutable");
    try {
      const bytes = await readFile(join(ASSETS_DIR, "mermaid.js"));
      return new Response(bytes, { status: 200, headers: h });
    } catch {
      return new Response("/* mermaid bundle missing — run pnpm docs:mermaid */", {
        status: 404,
        headers: h,
      });
    }
  });

  // The landing product-tour carousel bundle (Embla + autoplay), committed by
  // `pnpm landing:carousel`. Served same-origin so the marketing landing needs no
  // client bundler. Kept ahead of the webp-only `:file` route below.
  app.get("/docs/assets/landing-carousel.js", async () => {
    const h = new Headers();
    baseSecurityHeaders(h);
    h.set("Content-Type", "application/javascript; charset=utf-8");
    h.set("Cache-Control", "public, max-age=86400");
    try {
      const bytes = await readFile(join(ASSETS_DIR, "landing-carousel.js"));
      return new Response(bytes, { status: 200, headers: h });
    } catch {
      return new Response("/* carousel bundle missing — run pnpm landing:carousel */", {
        status: 404,
        headers: h,
      });
    }
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

  // Installable agent skill (U9), zipped in-process from an allowlist. Public.
  app.get("/skill.zip", (c) => {
    const zip = buildSkillZip();
    if (!zip) return c.notFound();
    const h = new Headers();
    baseSecurityHeaders(h);
    h.set("Content-Type", "application/zip");
    h.set("Content-Disposition", 'attachment; filename="canvas-drop-skill.zip"');
    h.set("Cache-Control", "public, max-age=3600");
    return new Response(zip, { status: 200, headers: h });
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
  app.get("/docs", (c) => docPage(c, "", origin, resolveSkin));
  // Any nested doc path (e.g. /docs/sdk/kv). Static routes above take priority.
  app.get("/docs/:path{.+}", (c) => docPage(c, c.req.param("path"), origin, resolveSkin));

  return app;
}

async function docPage(
  c: import("hono").Context<AppEnv>,
  path: string,
  origin: string,
  resolveSkin: () => Promise<SkinName>,
): Promise<Response> {
  const html = renderDocPage(path, origin, await resolveSkin());
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

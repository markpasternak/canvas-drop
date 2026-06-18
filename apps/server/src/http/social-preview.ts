import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { loginUrl, publicOrigin, requestReturnTo } from "../auth/return-to.js";
import { SESSION_COOKIE } from "../auth/session.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import { resolveRequest } from "../routing/resolve-request.js";
import { escapeAttribute, escapeHtml } from "./error-pages.js";
import { baseSecurityHeaders } from "./security-headers.js";
import type { AppEnv } from "./types.js";

/**
 * Social-preview shell for signed-out link unfurls (OPEN: nice shares).
 *
 * Problem: in `oidc` mode the auth gateway bounces every unauthenticated request
 * to `/auth/login` → the IdP. A link unfurler (iMessage, Slack, Discord, …) never
 * carries the session cookie, so it follows that redirect and scrapes the IdP's
 * "Sign in" page — the shared link previews as *Google's* login, not canvas-drop.
 *
 * Two cards, both pointing at the branded `/og.png` image:
 *
 *  1. **Per-canvas card** for a `public_link` canvas. The carve-out resolver sets
 *     an `anonymous` principal ONLY for `public_link` canvases (gated canvases —
 *     org-only, guest, password — never reach that branch), so the canvas's title
 *     is already public and surfacing it here cannot leak a private canvas's
 *     existence (§12.0). Served ONLY to actual crawler user-agents; a real human
 *     visitor falls through to the canvas itself.
 *  2. **Generic card** for any other signed-out top-level HTML navigation in `oidc`
 *     mode — one card for every gated link, leaking nothing about the target. Real
 *     humans are redirected straight on to `/auth/login` (parity with the gateway).
 *
 * Only active in `oidc` mode: `proxy` never reaches the app unauthenticated (the
 * IAP bounces it) and `dev` is always signed in. (The per-canvas branch keys off
 * the `anonymous` principal, which only exists in app-gated modes anyway.)
 */

const PREVIEW_TITLE = "canvas-drop";
const PREVIEW_DESC =
  "A shared canvas on canvas-drop. Sign in with your organization account to open it.";

// Crawlers that send a wildcard Accept (not text/html) but a recognizable UA.
const CRAWLER_UA =
  /bot|crawler|spider|facebookexternalhit|facebot|slack|twitter|discord|whatsapp|telegram|linkedin|pinterest|redditbot|embedly|skype|applebot|vkshare|preview|what-?app/i;

/** Does this request look like a top-level document fetch (vs an asset/API call)? */
function looksLikeDocument(accept: string, secFetchDest: string | undefined, ua: string): boolean {
  if (accept.includes("text/html")) return true;
  if (secFetchDest === "document") return true;
  return CRAWLER_UA.test(ua);
}

export function socialPreview(
  config: Config,
  canvases?: CanvasesRepository,
  /** Per-canvas OG image resolver (plan 004 / U9). Returns the canvas's preview OG
   *  URL when the pipeline is enabled AND a preview exists, else null → branded
   *  `/og.png`. Only consulted for the public_link card, so a gated canvas never
   *  emits a per-canvas image (R5). */
  previewImage?: (canvas: Canvas) => Promise<string | null>,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const principal = c.get("principal");
    const method = c.req.method;
    const isGetDoc = method === "GET" || method === "HEAD";
    const ua = c.req.header("user-agent") ?? "";

    // (1) A public_link canvas (anonymous principal) shared to a CRAWLER → a
    //     per-canvas card with the canvas's already-public title. A real visitor
    //     (non-crawler UA) falls through and gets the canvas itself.
    if (principal?.kind === "anonymous") {
      if (canvases && isGetDoc && CRAWLER_UA.test(ua)) {
        const { canvasSlug } = resolveRequest(
          { host: c.req.header("host") ?? "", pathname: c.req.path },
          config,
        );
        const canvas = canvasSlug ? await canvases.findBySlug(canvasSlug) : null;
        if (canvas) {
          const origin = publicOrigin(config, c.req.header("host"));
          const title = canvas.title?.trim() || PREVIEW_TITLE;
          // Per-canvas preview image when the pipeline is on + captured; else /og.png.
          // Best-effort: a resolver error (e.g. a DB blip on the settings/job lookup)
          // must fall back to the branded card, never 500 the unfurl (review #6).
          let image: string | undefined;
          try {
            image = (await previewImage?.(canvas)) ?? undefined;
          } catch {
            image = undefined;
          }
          return htmlResponse(
            renderPreviewShell(origin, c.req.path, {
              title,
              description: `${canvas.title?.trim() ? `“${title}” — ` : ""}a canvas shared on canvas-drop.`,
              redirect: false,
              image,
            }),
          );
        }
      }
      return next();
    }

    // (2) A guest/org principal is a real visitor → serve the real content.
    if (principal) return next();

    // (3) Signed-out navigation: generic card + redirect to login (oidc only).
    if (config.auth.mode !== "oidc") return next();
    if (!isGetDoc) return next();
    // A session cookie means a (possibly signed-in) human — let the gateway decide.
    if (getCookie(c, SESSION_COOKIE)) return next();
    if (
      !looksLikeDocument(
        c.req.header("accept") ?? "",
        c.req.header("sec-fetch-dest") ?? undefined,
        ua,
      )
    ) {
      return next();
    }
    const host = c.req.header("host") ?? "";
    const origin = publicOrigin(config, host);
    // Forward where the visitor was headed so they return to the shared canvas after
    // sign-in, not the apex welcome page.
    const loginHref = loginUrl(config, requestReturnTo(config, host, c.req.url));
    return htmlResponse(renderPreviewShell(origin, c.req.path, { loginHref }));
  });
}

function htmlResponse(html: string): Response {
  const headers = new Headers();
  baseSecurityHeaders(headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  // Don't cache (a later sign-in must reach real content) and keep the gated app
  // out of search indexes. A public_link's card is also kept out of search — a
  // public link is "anyone with the URL", not "search-discoverable".
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex");
  return new Response(html, { status: 200, headers });
}

/**
 * The signed-out preview page: OG/Twitter card + (for the generic gated card) an
 * immediate redirect to login. The per-canvas public card passes `redirect:false`
 * — it is served only to crawlers, so there is no human to forward.
 */
export function renderPreviewShell(
  origin: string,
  path: string,
  opts: {
    title?: string;
    description?: string;
    redirect?: boolean;
    loginHref?: string;
    image?: string;
  } = {},
): string {
  const base = origin.replace(/\/$/, "");
  const image = escapeHtml(opts.image ?? `${base}/og.png`);
  const url = escapeHtml(`${base}${path}`);
  const title = escapeHtml(opts.title ?? PREVIEW_TITLE);
  const desc = escapeHtml(opts.description ?? PREVIEW_DESC);
  const redirect = opts.redirect ?? true;
  // The href is built from validated input (loginUrl → safeReturnTo) and the query
  // value is percent-encoded, so it carries no HTML/JS metacharacters; escape it for
  // the attribute and JS-string contexts anyway as defense in depth.
  const loginHref = opts.loginHref ?? "/auth/login";
  const loginAttr = escapeAttribute(loginHref);
  const loginJs = escapeHtml(loginHref);
  const redirectHead = redirect
    ? `<meta http-equiv="refresh" content="0; url=${loginAttr}">
<script>location.replace("${loginJs}");</script>`
    : "";
  const body = redirect
    ? `<p>Sign in to open this shared canvas… <a href="${loginAttr}">Continue</a></p>`
    : `<p>${title}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="robots" content="noindex">
<meta name="description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="canvas-drop">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${image}">
${redirectHead}
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0b0b0d; color: #a1a1aa; }
  a { color: #56c9d3; text-decoration: none; }
</style>
</head>
<body>
  ${body}
</body>
</html>`;
}

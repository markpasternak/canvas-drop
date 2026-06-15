import type { Config } from "@canvas-drop/shared";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { SESSION_COOKIE } from "../auth/session.js";
import { escapeHtml } from "./error-pages.js";
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
 * Fix: BEFORE the gateway, intercept signed-out top-level HTML navigations and
 * return a tiny public page carrying generic Open Graph / Twitter tags that point
 * at the branded `/og.png` card. Crawlers scrape that; real humans are redirected
 * straight on to `/auth/login` (parity with the gateway), so their flow is
 * unchanged bar an instant client redirect.
 *
 * Deliberately GENERIC for now — one card for every link. It never looks up or
 * leaks anything about the specific canvas (title/existence) pre-auth; per-canvas
 * preview images are a later, opt-in step. Only active in `oidc` mode: `proxy`
 * mode never reaches the app unauthenticated (the IAP bounces it) and `dev` mode
 * is always signed in.
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

export function socialPreview(config: Config) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // A guest/anonymous principal was already resolved (U7) — this is a real
    // visitor to an invited or public canvas, not a signed-out human to bounce.
    if (c.get("principal")) return next();
    // Only oidc bounces to an external login page; other modes don't have the bug.
    if (config.auth.mode !== "oidc") return next();
    // Only GET/HEAD navigations; never touch mutations or the API surface.
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    // A session cookie means a (possibly signed-in) human — let the gateway decide.
    if (getCookie(c, SESSION_COOKIE)) return next();
    if (
      !looksLikeDocument(
        c.req.header("accept") ?? "",
        c.req.header("sec-fetch-dest") ?? undefined,
        c.req.header("user-agent") ?? "",
      )
    ) {
      return next();
    }

    // Absolute og:image/og:url on THIS host (works on canvas subdomains too —
    // `/og.png` is served host-agnostically before the gateway). Mirror the
    // instance's configured scheme rather than the proxy→app hop's plain http.
    const scheme = config.baseUrl.startsWith("https") ? "https" : "http";
    const host = c.req.header("host") ?? new URL(config.baseUrl).host;
    const origin = `${scheme}://${host}`;
    return htmlResponse(renderPreviewShell(origin, c.req.path));
  });
}

function htmlResponse(html: string): Response {
  const headers = new Headers();
  baseSecurityHeaders(headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  // Don't cache (a later sign-in must reach real content) and keep the gated app
  // out of search indexes.
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex");
  return new Response(html, { status: 200, headers });
}

/** The signed-out preview page: generic OG card + an immediate redirect to login. */
export function renderPreviewShell(origin: string, path: string): string {
  const base = origin.replace(/\/$/, "");
  const image = escapeHtml(`${base}/og.png`);
  const url = escapeHtml(`${base}${path}`);
  const title = escapeHtml(PREVIEW_TITLE);
  const desc = escapeHtml(PREVIEW_DESC);
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
<meta http-equiv="refresh" content="0; url=/auth/login">
<script>location.replace("/auth/login");</script>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0b0b0d; color: #a1a1aa; }
  a { color: #60a5fa; text-decoration: none; }
</style>
</head>
<body>
  <p>Redirecting to sign in… <a href="/auth/login">Continue</a></p>
</body>
</html>`;
}

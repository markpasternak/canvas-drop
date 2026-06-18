import { rampCssVars } from "@canvas-drop/shared";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { BRAND_MARK } from "./brand.js";
import { baseSecurityHeaders } from "./security-headers.js";
import type { AppEnv } from "./types.js";

export interface ErrorPageDetails {
  status: number;
  code: string;
  title?: string;
  message?: string;
  hint?: string;
  requestPath?: string;
  actionHref?: string;
  actionLabel?: string;
}

interface ErrorBody {
  code?: unknown;
  error?: unknown;
  message?: unknown;
  path?: unknown;
}

/** HTML is opt-in: real browser navigations prefer text/html; API clients do not. */
export function wantsHtmlError(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const htmlQ = mediaQuality(accept, "text/html");
  if (htmlQ <= 0) return false;
  const jsonQ = mediaQuality(accept, "application/json");
  const wildcardQ = Math.max(mediaQuality(accept, "*/*"), mediaQuality(accept, "application/*"));
  return htmlQ > jsonQ && htmlQ >= wildcardQ;
}

export function errorPageMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    await next();

    if (c.req.method === "HEAD" || !wantsHtmlError(c.req.header("accept"))) return;
    const res = c.res;
    if (res.status < 400) return;
    if (!isJsonResponse(res)) return;

    const text = await res
      .clone()
      .text()
      .catch(() => "");
    if (!text) return;

    const body = parseBody(text);
    const details = detailsFromBody(c, res.status, res.statusText, body);
    const headers = new Headers(res.headers);
    htmlHeaders(headers);
    c.res = new Response(renderErrorPage(details), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  });
}

export function errorResponse(
  c: Context<AppEnv>,
  details: ErrorPageDetails,
  jsonBody: Record<string, unknown>,
  headersInit?: ConstructorParameters<typeof Headers>[0],
): Response {
  const headers = new Headers(headersInit);
  baseSecurityHeaders(headers);
  appendVary(headers, "Accept");

  if (wantsHtmlError(c.req.header("accept")) && c.req.method !== "HEAD") {
    htmlHeaders(headers);
    return new Response(renderErrorPage(withRequestPath(c, details)), {
      status: details.status,
      headers,
    });
  }

  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(jsonBody), {
    status: details.status,
    headers,
  });
}

/**
 * The light + dark token palettes, factored out so callers that support a manual
 * theme override (the docs site, via a `data-theme` attribute matching the
 * dashboard) can re-assert either palette without duplicating the values.
 */
// Derived from the canonical BRAND_TOKENS (single source — no drift, no parallel
// ramp). Shadows are the only system-page-specific addition.
export const LIGHT_TOKENS = `${rampCssVars("light", "    ")}
    --shadow-color: 40 30% 38%;
    --shadow-panel: 0 18px 60px hsl(var(--shadow-color) / 0.09);`;

export const DARK_TOKENS = `${rampCssVars("dark", "    ")}
    --shadow-color: 265 60% 2%;
    --shadow-panel: 0 18px 60px hsl(var(--shadow-color) / 0.5);`;

/**
 * Shared visual chrome for self-contained system pages (the branded 4xx/5xx
 * error pages AND the canvas password gate, §14.5). Both pages emit this token
 * block + brand header so they render in ONE design language and cannot drift
 * apart. Page-specific layout (error meta grid, gate form) is layered after.
 */
export const SYSTEM_PAGE_STYLES = `  /* Self-hosted Newsreader (the editorial serif), served same-origin by
     brandAssetRoutes() — these pre-gateway pages need no CDN, matching the
     landing page + the dashboard @fontsource definitions. */
  @font-face {
    font-family: "Newsreader Variable";
    font-style: normal;
    font-display: swap;
    font-weight: 200 800;
    src: url(/fonts/newsreader-latin-wght-normal.woff2) format("woff2-variations");
  }
  :root {
    color-scheme: light dark;
${LIGHT_TOKENS}
    --font-serif: "Newsreader Variable", Georgia, "Times New Roman", serif;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: clamp(1.5rem, 5vw, 4rem);
    background:
      radial-gradient(circle at 18% 12%, color-mix(in srgb, var(--accent-subtle), transparent 30%), transparent 32rem),
      linear-gradient(155deg, var(--canvas), var(--surface-sunken));
    color: var(--fg);
    font: 15px/1.55 "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  /* Flat + card-less: content sits on the page (brand mark + content), not boxed in
     a heavy card with a filled header bar — mirrors the dashboard's flat surfaces. */
  main { width: min(100%, 40rem); }
  .brand {
    display: flex;
    align-items: center;
    gap: .6rem;
    margin: 0 0 clamp(2rem, 6vw, 3rem);
    font-weight: 650;
    letter-spacing: -.011em;
  }
  .mark {
    width: 1.9rem;
    height: 1.9rem;
    flex: 0 0 auto;
  }
  @media (prefers-color-scheme: dark) {
    :root {
${DARK_TOKENS}
    }
  }
  /* Manual theme override (data-theme), set pre-paint by SYSTEM_THEME_INIT from the
     dashboard's canvas-drop-theme choice. The attribute selectors outrank the media
     query, so an explicit light/dark choice wins over the OS — matching the docs. */
  :root[data-theme="dark"] {
${DARK_TOKENS}
  }
  :root[data-theme="light"] {
${LIGHT_TOKENS}
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .01ms !important;
      transition-duration: .01ms !important;
    }
  }`;

/**
 * Pre-paint theme sync for self-contained server pages. Mirrors the dashboard +
 * docs mechanism: an explicit `?theme=light|dark` wins for the initial paint, else
 * the persisted `canvas-drop-theme` choice, else the OS (no attribute → the
 * prefers-color-scheme media query). Inline + synchronous in <head> so there's no
 * flash. Static markup (no user input), so it needs no CSP relaxation beyond the
 * pages' existing policy (which sets no script-src).
 *
 * NOTE: localStorage is per-origin — this carries the dashboard's choice on
 * app-origin pages (and path-mode canvas pages), but NOT onto canvas subdomains
 * (different origin); those still follow the OS. See the brand-conventions learning.
 */
export const SYSTEM_THEME_INIT = `<script>
  (() => {
    try {
      const p = new URLSearchParams(location.search).get("theme");
      const s = localStorage.getItem("canvas-drop-theme");
      const c = p === "light" || p === "dark" ? p : (s === "light" || s === "dark" ? s : "system");
      if (c !== "system") document.documentElement.setAttribute("data-theme", c);
    } catch (_) {
      /* private mode / no storage — fall back to prefers-color-scheme */
    }
  })();
</script>`;

/** The canvas-drop logo + wordmark header, shared by every system page. */
export const SYSTEM_PAGE_BRAND = `    <div class="brand">
      ${BRAND_MARK}
      <span>canvas-drop</span>
    </div>`;

/** The brand mark in an inline (`<span>`) wrapper, for contexts that nest it
 * inside an anchor (the docs topbar). Computed once here so callers never do
 * string surgery on `SYSTEM_PAGE_BRAND`'s markup. */
export const SYSTEM_PAGE_BRAND_INLINE = SYSTEM_PAGE_BRAND.replace(
  '<div class="brand">',
  '<span class="brand">',
).replace("</div>", "</span>");

function renderErrorPage(input: ErrorPageDetails): string {
  const details = normalizeDetails(input);
  const title = escapeHtml(details.title);
  const message = escapeHtml(details.message);
  const code = escapeHtml(details.code);
  const status = escapeHtml(String(details.status));
  const path = details.requestPath ? escapeHtml(details.requestPath) : "";
  const hint = details.hint ? escapeHtml(details.hint) : "";
  const actionHref = escapeAttribute(details.actionHref ?? "/");
  const actionLabel = escapeHtml(details.actionLabel ?? "Open dashboard");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${status} ${title}</title>
${SYSTEM_THEME_INIT}
<style>
${SYSTEM_PAGE_STYLES}
  .kicker {
    margin: 0 0 1rem;
    color: var(--subtle);
    font: 700 .75rem/1 ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: .1em;
    text-transform: uppercase;
  }
  h1 {
    margin: 0;
    max-width: 14ch;
    color: var(--fg);
    font-family: var(--font-serif);
    font-optical-sizing: auto;
    font-weight: 500;
    font-size: clamp(2.25rem, 7vw, 3.75rem);
    line-height: 1.02;
    letter-spacing: -.02em;
  }
  .message {
    margin: 1.25rem 0 0;
    max-width: 54ch;
    color: var(--muted);
    font-size: 1.0625rem;
    line-height: 1.6;
  }
  /* Flat spec list — hairline-divided rows, not a sunken boxed panel. */
  .meta {
    display: grid;
    grid-template-columns: minmax(5rem, auto) 1fr;
    margin: 2rem 0 0;
    border-top: 1px solid var(--border);
  }
  dt {
    align-self: center;
    padding: .7rem 1rem .7rem 0;
    border-bottom: 1px solid var(--border);
    color: var(--subtle);
    font-size: .75rem;
    font-weight: 600;
  }
  dd {
    min-width: 0;
    margin: 0;
    padding: .7rem 0;
    border-bottom: 1px solid var(--border);
    overflow-wrap: anywhere;
    color: var(--fg);
    font: .8125rem/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  }
  /* A quiet accent note (callout), not a bordered box. */
  .hint {
    margin: 1.25rem 0 0;
    padding: .8rem 1rem;
    border-radius: .625rem;
    background: var(--accent-subtle);
    color: var(--accent);
    font-size: .9rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: .75rem;
    margin-top: 1.75rem;
  }
  a {
    display: inline-flex;
    min-height: 2.5rem;
    align-items: center;
    justify-content: center;
    border-radius: .5rem;
    background: var(--accent);
    color: var(--accent-fg);
    padding: .6rem .95rem;
    font-size: .875rem;
    font-weight: 650;
    text-decoration: none;
    transition: transform .1s cubic-bezier(.16, 1, .3, 1), background-color .1s cubic-bezier(.16, 1, .3, 1);
  }
  a:hover { background: var(--accent-hover); }
  a:active { transform: translateY(1px); }
  a:focus-visible { outline: 2px solid var(--accent-hover); outline-offset: 2px; }
</style>
</head>
<body>
  <main>
${SYSTEM_PAGE_BRAND}
    <section class="content" aria-labelledby="error-title">
      <p class="kicker">HTTP ${status}</p>
      <h1 id="error-title">${title}</h1>
      <p class="message">${message}</p>
      <dl class="meta">
        <dt>Code</dt><dd>${code}</dd>
        ${path ? `<dt>Path</dt><dd>${path}</dd>` : ""}
      </dl>
      ${hint ? `<p class="hint">${hint}</p>` : ""}
      <div class="actions"><a href="${actionHref}">${actionLabel}</a></div>
    </section>
  </main>
</body>
</html>`;
}

function detailsFromBody(
  c: Context<AppEnv>,
  status: number,
  statusText: string,
  body: ErrorBody,
): ErrorPageDetails {
  const code = stringField(body.code) ?? stringField(body.error) ?? `http_${status}`;
  const path = stringField(body.path) ?? requestPath(c);
  return {
    status,
    code,
    title: titleFor(status, code, statusText),
    message: stringField(body.message) ?? fallbackMessage(status, code, statusText),
    requestPath: path,
  };
}

function withRequestPath(c: Context<AppEnv>, details: ErrorPageDetails): ErrorPageDetails {
  return { ...details, requestPath: details.requestPath ?? requestPath(c) };
}

function normalizeDetails(
  input: ErrorPageDetails,
): Required<Omit<ErrorPageDetails, "hint">> & Pick<ErrorPageDetails, "hint"> {
  const code = input.code || `http_${input.status}`;
  return {
    status: input.status,
    code,
    title: input.title ?? titleFor(input.status, code, ""),
    message: input.message ?? fallbackMessage(input.status, code, ""),
    requestPath: input.requestPath ?? "",
    actionHref: input.actionHref ?? "/",
    actionLabel: input.actionLabel ?? "Open dashboard",
    hint: input.hint,
  };
}

function titleFor(status: number, code: string, statusText: string): string {
  switch (code) {
    case "dashboard_not_built":
      return "Dashboard not built";
    case "disabled":
      return "This canvas is disabled";
    case "not_implemented":
      return "Not implemented";
    case "rate_limited":
    case "RATE_LIMITED":
      return "Too many requests";
    default:
      break;
  }

  if (status === 401) return "Sign in required";
  if (status === 403) return "Access denied";
  if (status === 404) return "Page not found";
  if (status === 429) return "Too many requests";
  if (status === 500) return "Internal server error";
  if (status === 503) return "Service unavailable";
  return statusText || "Request failed";
}

function fallbackMessage(status: number, code: string, statusText: string): string {
  if (status === 500) return "The server hit an unexpected problem. Please try again.";
  const human = humanizeCode(code);
  if (human) return `${human}.`;
  return statusText || "Request failed.";
}

function humanizeCode(code: string): string {
  return code
    .replace(/^http_\d+$/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function isJsonResponse(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

function parseBody(text: string): ErrorBody {
  try {
    const parsed = JSON.parse(text) as ErrorBody;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function requestPath(c: Context<AppEnv>): string {
  try {
    return new URL(c.req.url).pathname;
  } catch {
    return c.req.path;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function htmlHeaders(headers: Headers): void {
  baseSecurityHeaders(headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  }
  headers.delete("Content-Length");
  appendVary(headers, "Accept");
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", value);
    return;
  }
  const parts = current.split(",").map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) headers.set("Vary", `${current}, ${value}`);
}

function mediaQuality(accept: string, mediaType: string): number {
  let best = 0;
  for (const part of accept.split(",")) {
    const [rawType, ...params] = part.trim().split(";");
    if (!rawType) continue;
    if (rawType.trim().toLowerCase() !== mediaType) continue;
    const q = params
      .map((param) => param.trim())
      .find((param) => param.toLowerCase().startsWith("q="));
    const parsed = q ? Number(q.slice(2)) : 1;
    if (Number.isFinite(parsed)) best = Math.max(best, Math.max(0, Math.min(1, parsed)));
  }
  return best;
}

/** Escape a string for safe interpolation into HTML text or attribute context.
 * Shared by every self-rendered server page (error, legal, password gate, docs). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
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
 * Shared visual chrome for self-contained system pages (the branded 4xx/5xx
 * error pages AND the canvas password gate, §14.5). Both pages emit this token
 * block + brand header so they render in ONE design language and cannot drift
 * apart. Page-specific layout (error meta grid, gate form) is layered after.
 */
export const SYSTEM_PAGE_STYLES = `  :root {
    color-scheme: light dark;
    --canvas: #f5f5f2;
    --surface: #fbfbf8;
    --surface-raised: #fefefb;
    --surface-sunken: #ededeb;
    --fg: #18181b;
    --muted: #5b5b63;
    --subtle: #898991;
    --border: #dfdfdc;
    --border-strong: #c8c8c3;
    --accent: #2563eb;
    --accent-hover: #1d4ed8;
    --accent-fg: #f8fbff;
    --accent-subtle: #eaf1ff;
    --logo-frame: #111418;
    --logo-drop: #2563eb;
    --shadow-color: 240 12% 12%;
    --shadow-panel: 0 18px 60px hsl(var(--shadow-color) / 0.08);
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: clamp(1.25rem, 3vw, 3rem);
    background:
      radial-gradient(circle at 18% 12%, color-mix(in srgb, var(--accent-subtle), transparent 28%), transparent 30rem),
      linear-gradient(135deg, var(--canvas), var(--surface-sunken));
    color: var(--fg);
    font: 15px/1.55 "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  main {
    width: min(100%, 42rem);
    border: 1px solid var(--border);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    box-shadow: var(--shadow-panel);
    overflow: hidden;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: .65rem;
    padding: 1rem 1.15rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface-raised);
    font-weight: 650;
    letter-spacing: -.011em;
  }
  .mark {
    width: 2rem;
    height: 2rem;
    flex: 0 0 auto;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --canvas: #0b0b0d;
      --surface: #141416;
      --surface-raised: #1c1c20;
      --surface-sunken: #09090b;
      --fg: #f4f4f5;
      --muted: #a1a1aa;
      --subtle: #6e6e78;
      --border: #27272b;
      --border-strong: #3a3a40;
      --accent: #60a5fa;
      --accent-hover: #93c5fd;
      --accent-fg: #07111f;
      --accent-subtle: #0d2a4d;
      --logo-frame: #f4f4f5;
      --logo-drop: #60a5fa;
      --shadow-color: 0 0% 0%;
      --shadow-panel: 0 18px 60px hsl(var(--shadow-color) / 0.28);
    }
    body {
      background:
        radial-gradient(circle at 18% 12%, color-mix(in srgb, var(--accent-subtle), transparent 35%), transparent 30rem),
        linear-gradient(135deg, var(--canvas), var(--surface-sunken));
    }
    main { background: color-mix(in srgb, var(--surface) 96%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .01ms !important;
      transition-duration: .01ms !important;
    }
  }`;

/** The Canvasdrop logo + wordmark header, shared by every system page. */
export const SYSTEM_PAGE_BRAND = `    <div class="brand">
      <svg class="mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <path d="M14 37h-4a5 5 0 0 1-5-5V11a5 5 0 0 1 5-5h28a5 5 0 0 1 5 5v21a5 5 0 0 1-5 5h-4" stroke="var(--logo-frame)" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.75"/>
        <path d="M24 14v16.5m-7-7 7 7 7-7" stroke="var(--logo-drop)" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.75"/>
        <path d="M18 40h12" stroke="var(--logo-drop)" stroke-linecap="round" stroke-width="4.75"/>
      </svg>
      <span>Canvasdrop</span>
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
<style>
${SYSTEM_PAGE_STYLES}
  .content { padding: clamp(1.5rem, 4vw, 2.5rem); }
  .kicker {
    margin: 0 0 .75rem;
    color: var(--subtle);
    font: 700 .75rem/1 ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: .08em;
  }
  h1 {
    margin: 0;
    max-width: 12ch;
    color: var(--fg);
    font-size: clamp(2rem, 8vw, 4.25rem);
    line-height: .96;
    letter-spacing: -.03em;
  }
  .message {
    margin: 1.15rem 0 0;
    max-width: 58ch;
    color: var(--muted);
    font-size: 1rem;
  }
  .meta {
    display: grid;
    grid-template-columns: minmax(5rem, auto) 1fr;
    gap: .65rem 1rem;
    margin: 1.5rem 0 0;
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: .75rem;
    background: var(--surface-sunken);
  }
  dt {
    color: var(--subtle);
    font-size: .75rem;
    font-weight: 600;
  }
  dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--fg);
    font: .8125rem/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  }
  .hint {
    margin: 1rem 0 0;
    padding: .85rem 1rem;
    border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
    border-radius: .75rem;
    background: var(--accent-subtle);
    color: var(--accent);
    font-size: .875rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: .75rem;
    margin-top: 1.5rem;
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

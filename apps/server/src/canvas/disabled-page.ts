import type { Context } from "hono";
import { baseSecurityHeaders } from "../http/security-headers.js";
import type { AppEnv } from "../http/types.js";

/**
 * Disabled-canvas response (§6.10.2, M7). A taken-down canvas's public URL shows
 * this page; the runtime API returns the typed `{ code: "DISABLED" }` 403 instead
 * (handled in canvas-api.ts). Content-negotiated, mirroring `serve.ts`'s 404:
 * browsers get a small self-contained HTML page, programmatic clients get the
 * stable `{ error: "disabled" }` JSON.
 *
 * The page is **static and org-agnostic** — the admin's `disabledReason` is NOT
 * interpolated here (it would leak an operator's internal note to anyone with the
 * URL). The owner sees the specific reason in their authenticated dashboard
 * (the owner/admin-gated `disabledReason` projection), never on this public page.
 *
 * Lives in its own module (not `serve.ts`) so `authorization.ts` can import it
 * without an `authorization.ts → serve.ts` dependency.
 */
export function disabledResponse(c: Context<AppEnv>): Response {
  const wantsHtml = c.req.header("accept")?.includes("text/html") ?? false;
  const headers = new Headers({
    "Content-Type": wantsHtml ? "text/html; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
  });
  securityHeaders(headers);
  const body = wantsHtml ? disabledPage() : JSON.stringify({ error: "disabled" });
  return c.body(body, 403, Object.fromEntries(headers));
}

/** §12.4 baseline (shared helper) + the content-surface frame-ancestors. */
function securityHeaders(headers: Headers): void {
  baseSecurityHeaders(headers);
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
}

/** A tiny, dependency-free, org-agnostic "disabled" page (light + dark). No canvas
 *  data interpolated — nothing to escape or leak. */
function disabledPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Canvas disabled</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 2rem;
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #fbfbfc; color: #1a1a1e; }
  main { max-width: 26rem; text-align: center; }
  .code { margin: 0; font: 600 .75rem ui-monospace, monospace; letter-spacing: .08em; color: #8a8a93; }
  h1 { margin: .5rem 0; font-size: 1.375rem; letter-spacing: -.01em; }
  p.msg { margin: 0; color: #56565f; }
  .hint { margin-top: 1.25rem; padding: .5rem .75rem; display: inline-block; border-radius: .5rem;
    font: .8125rem ui-monospace, monospace; color: #56565f; background: rgba(0,0,0,.04); }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0c; color: #f4f4f5; }
    p.msg, .code, .hint { color: #a1a1aa; } .hint { background: rgba(255,255,255,.06); }
  }
</style>
</head>
<body>
  <main>
    <p class="code">DISABLED</p>
    <h1>This canvas is disabled</h1>
    <p class="msg">A platform administrator has taken this canvas offline.</p>
    <p class="hint">If you own it, sign in to your dashboard to see why.</p>
  </main>
</body>
</html>`;
}

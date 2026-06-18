import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AuditLog } from "../audit/audit-log.js";
import { escapeHtml, SYSTEM_PAGE_BRAND, SYSTEM_PAGE_STYLES } from "../http/error-pages.js";
import { type RateLimitStore, takeToken } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";
import { principalAttributionId, requestPrincipal } from "./authorization.js";
import { verifyPassword } from "./password.js";

const GATE_COOKIE = "__canvasdrop_gate";

/**
 * HMAC-sign a gate grant bound to the canvas id + its current passwordVersion.
 * Rotating the password bumps passwordVersion (U14), so outstanding cookies stop
 * validating — revocation invalidates gate cookies (D23).
 */
function signGrant(secret: string, canvasId: string, passwordVersion: number): string {
  const mac = createHmac("sha256", secret).update(`${canvasId}.${passwordVersion}`).digest("hex");
  return `${passwordVersion}.${mac}`;
}

function verifyGrant(secret: string, canvas: Canvas, cookieValue: string | undefined): boolean {
  if (!cookieValue) return false;
  const dot = cookieValue.indexOf(".");
  if (dot < 0) return false;
  const version = Number(cookieValue.slice(0, dot));
  if (version !== canvas.passwordVersion) return false; // rotated → invalid
  const expected = signGrant(secret, canvas.id, canvas.passwordVersion);
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Cookie scope. Subdomain mode: each canvas is its own origin, so the grant is
 * host-only (no Domain) and never sent to sibling canvas subdomains. Path mode:
 * all canvases share one host, so the grant is scoped to the canvas path prefix.
 */
function gateCookieOptions(config: Config, slug: string) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "Lax" as const,
    path: config.urlMode === "subdomain" ? "/" : `/c/${slug}/`,
  };
}

export interface PasswordGateDeps {
  config: Config;
  audit: AuditLog;
  /** Shared rate-limit store (M7) — throttles gate attempts (§12.3 5/min/user). */
  rateLimitStore?: RateLimitStore;
}

/**
 * Password gate (§6.3.7, §12.1.3). Runs after canvasAccess (U15) only when
 * `needsPasswordGate` is set. A valid grant cookie proceeds to serving; a POST
 * with the right password mints the cookie; otherwise the gate page is shown.
 */
export function passwordGate(deps: PasswordGateDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get("needsPasswordGate")) return next();
    const canvas = c.get("canvas") as Canvas;
    const secret = deps.config.sessionSecret;

    if (verifyGrant(secret, canvas, getCookie(c, GATE_COOKIE))) {
      return next();
    }

    // Gate submission: a POST carrying the password.
    if (c.req.method === "POST") {
      // Throttle password-gate attempts (§12.3 5/min/user/canvas) — slows brute
      // force of a protected canvas's password (§12.0 #3).
      if (deps.rateLimitStore && deps.config.rateLimit.enabled) {
        // Key by the member's id, or by client IP for an anonymous public visitor
        // (no org user on a public_link canvas, U11).
        const principal = requestPrincipal(c);
        const bucket =
          principal.kind === "member" ? principal.id : `anon:${c.get("clientIp") ?? "unknown"}`;
        const r = takeToken(
          deps.rateLimitStore,
          `pwgate:${bucket}:${canvas.id}`,
          deps.config.rateLimit.passwordGatePerMin,
        );
        if (!r.allowed) {
          c.header("Retry-After", String(r.retryAfterSec));
          return c.html(gatePage(canvas.title, true), 429);
        }
      }
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const password = typeof form.password === "string" ? form.password : "";
      const ok = canvas.passwordHash ? await verifyPassword(canvas.passwordHash, password) : false;
      deps.audit.recordAudit({
        action: "password_attempt",
        actorId: principalAttributionId(c),
        targetId: canvas.id,
        meta: { success: ok },
        ip: c.get("clientIp"),
      });
      if (ok) {
        setCookie(
          c,
          GATE_COOKIE,
          signGrant(secret, canvas.id, canvas.passwordVersion),
          gateCookieOptions(deps.config, canvas.slug),
        );
        return c.redirect(c.req.path, 303); // re-GET, now past the gate
      }
      return c.html(gatePage(canvas.title, true), 401);
    }

    return c.html(gatePage(canvas.title, false), 401);
  });
}

/**
 * The password-gate page. Shares the branded system-page chrome (tokens + logo
 * header) with the 4xx/5xx error pages so a recipient opening a protected share
 * link sees the same design language, not a one-off (§14.5). Only the form is
 * gate-specific.
 */
export function gatePage(title: string, error: boolean): string {
  const name = title ? escapeHtml(title) : "This canvas";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex">
<title>Password required</title>
<style>
${SYSTEM_PAGE_STYLES}
  main { width: min(100%, 27rem); }
  .content { padding: clamp(1.5rem, 4vw, 2rem); }
  .kicker {
    margin: 0 0 .6rem;
    color: var(--subtle);
    font: 700 .75rem/1 ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  h1 { margin: 0; color: var(--fg); font-family: var(--font-serif); font-optical-sizing: auto; font-weight: 500; font-size: 1.6rem; line-height: 1.2; letter-spacing: -.015em; }
  .lede { margin: .5rem 0 1.25rem; color: var(--muted); font-size: .9rem; }
  .err {
    margin: 0 0 .85rem;
    padding: .6rem .75rem;
    border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
    border-radius: .6rem;
    background: var(--accent-subtle);
    color: var(--accent);
    font-size: .85rem;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: .6rem .75rem;
    margin: 0 0 .85rem;
    border: 1px solid var(--border-strong);
    border-radius: .5rem;
    background: var(--surface-raised);
    color: var(--fg);
    font: inherit;
  }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-color: var(--accent); }
  button {
    width: 100%;
    min-height: 2.5rem;
    padding: .6rem;
    border: 0;
    border-radius: .5rem;
    background: var(--accent);
    color: var(--accent-fg);
    font: 650 .9rem/1 inherit;
    cursor: pointer;
    transition: transform .1s cubic-bezier(.16, 1, .3, 1), background-color .1s cubic-bezier(.16, 1, .3, 1);
  }
  button:hover { background: var(--accent-hover); }
  button:active { transform: translateY(1px); }
  button:focus-visible { outline: 2px solid var(--accent-hover); outline-offset: 2px; }
</style>
</head>
<body>
  <main>
${SYSTEM_PAGE_BRAND}
    <section class="content">
      <p class="kicker">Protected</p>
      <h1>${name} is password-protected</h1>
      <p class="lede">Enter the password to continue.</p>
      ${error ? '<div class="err">Incorrect password. Try again.</div>' : ""}
      <form method="POST">
        <input type="password" name="password" autofocus autocomplete="current-password" aria-label="Password" placeholder="Password"/>
        <button type="submit">Unlock</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

export { GATE_COOKIE, signGrant, verifyGrant };

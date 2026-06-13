import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AuditLog } from "../audit/audit-log.js";
import type { AppEnv } from "../http/types.js";
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
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const password = typeof form.password === "string" ? form.password : "";
      const ok = canvas.passwordHash ? await verifyPassword(canvas.passwordHash, password) : false;
      deps.audit.recordAudit({
        action: "password_attempt",
        actorId: c.get("user").id,
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

/** Minimal styled gate page (system pages get the same care, §14.5). */
export function gatePage(title: string, error: boolean): string {
  const name = title ? escapeHtml(title) : "This canvas";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Password required</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0b0c;color:#e8e8ea}
.card{max-width:22rem;width:90%;padding:2rem;border:1px solid #2a2a2e;border-radius:12px;background:#141417}
h1{font-size:1.1rem;margin:0 0 .25rem}p{margin:.25rem 0 1rem;color:#a0a0a8}
input{width:100%;box-sizing:border-box;padding:.6rem .7rem;border:1px solid #34343a;border-radius:8px;background:#0e0e10;color:inherit;margin-bottom:.75rem}
button{width:100%;padding:.6rem;border:0;border-radius:8px;background:#e8e8ea;color:#0b0b0c;font-weight:600;cursor:pointer}
.err{color:#ff8585;font-size:.875rem;margin-bottom:.5rem}
</style></head><body>
<form class="card" method="POST">
<h1>${name} is password-protected</h1>
<p>Enter the password to continue.</p>
${error ? '<div class="err">Incorrect password. Try again.</div>' : ""}
<input type="password" name="password" autofocus autocomplete="current-password" aria-label="Password"/>
<button type="submit">Unlock</button>
</form></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );
}

export { GATE_COOKIE, signGrant, verifyGrant };

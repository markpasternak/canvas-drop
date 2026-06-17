import type { Config } from "@canvas-drop/shared";
import { Hono } from "hono";
import type { AuditLog } from "../audit/audit-log.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import { errorResponse } from "../http/error-pages.js";
import { type RateLimitStore, takeToken } from "../http/rate-limit.js";
import { isSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
import type { GuestService } from "./guest.js";

export interface GuestRoutesDeps {
  config: Config;
  guests: GuestService;
  canvases: CanvasesRepository;
  audit?: AuditLog;
  rateLimitStore?: RateLimitStore;
}

/** Branded "this link isn't valid" page (expired / used / revoked). */
function invalidLink(c: Parameters<typeof errorResponse>[0]) {
  return errorResponse(
    c,
    {
      status: 410,
      code: "invite_invalid",
      title: "This invite link isn't valid",
      message: "It may have expired, already been used, or been revoked.",
      hint: "Ask the person who shared it to send you a new invite.",
    },
    { error: "invite_invalid" },
    { "Cache-Control": "no-store" },
  );
}

/** Minimal, org-agnostic landing page: a same-origin POST consumes the token.
 *  The GET never consumes (so an email-client prefetch / `<img>` can't burn the
 *  single-use token); the explicit button POST is what signs the guest in. */
function landingPage(token: string): string {
  const safe = encodeURIComponent(token);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Open shared canvas</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0c;color:#e7e7e9;display:grid;place-items:center;min-height:100vh;margin:0}
.card{max-width:24rem;padding:2rem;text-align:center}button{font:inherit;padding:.7rem 1.4rem;border:0;border-radius:.6rem;background:#0c7b88;color:#fff;cursor:pointer}
h1{font-size:1.2rem}p{color:#a0a0a8}</style></head>
<body><div class="card"><h1>You've been invited to a canvas</h1>
<p>Click below to open it. This link is just for you.</p>
<form method="post" action="/guest/${safe}"><button type="submit">Open the canvas</button></form>
</div></body></html>`;
}

/**
 * Public magic-link routes (U8), mounted in the pre-gateway band (no org session
 * required). GET renders a landing page that does NOT consume the token;
 * a same-origin POST consumes it, establishes the guest session, and redirects to
 * the canvas. Throttled by client IP to resist token enumeration.
 */
export function guestRoutes(deps: GuestRoutesDeps) {
  const app = new Hono<AppEnv>();

  app.use("/guest/:token", async (c, next) => {
    if (deps.config.rateLimit.enabled && deps.rateLimitStore) {
      const ip = c.get("clientIp") ?? "unknown";
      const r = takeToken(deps.rateLimitStore, `guest:${ip}`, deps.config.rateLimit.loginPerMin);
      if (!r.allowed) {
        c.header("Retry-After", String(r.retryAfterSec));
        return c.json({ error: "rate_limited" }, 429);
      }
    }
    await next();
  });

  app.get("/guest/:token", (c) => {
    return c.html(landingPage(c.req.param("token")));
  });

  app.post("/guest/:token", async (c) => {
    // The consuming POST is same-origin only (it mints a session): a cross-site
    // form can't burn the single-use token or fixate a victim into a guest session.
    // Non-browser clients (no fetch-metadata, no Origin) are still allowed.
    if (!isSameOrigin(c, deps.config)) {
      return c.json({ error: "cross_origin_forbidden" }, 403);
    }
    const principal = await deps.guests.consumeMagicLink(c, c.req.param("token"));
    if (principal?.kind !== "guest") return invalidLink(c);
    const canvas = await deps.canvases.findById(principal.canvasId);
    if (canvas?.status !== "active") return invalidLink(c);
    deps.audit?.recordAudit({
      action: "guest_login",
      targetId: canvas.id,
      meta: { email: principal.email },
    });
    return c.redirect(canvasUrl(deps.config, canvas.slug));
  });

  return app;
}

import type { Config } from "@canvas-drop/shared";
import { Hono } from "hono";
import { errorResponse } from "../http/error-pages.js";
import { type RateLimitStore, takeToken } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";

export interface GuestRoutesDeps {
  config: Config;
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

/**
 * Retired guest magic-link routes. Kept mounted so old emailed URLs fail with a
 * branded no-store page instead of falling through to the auth gateway or burning
 * credentials. No route here consumes a token or sets a guest cookie.
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

  app.get("/guest/:token", (c) => invalidLink(c));
  app.post("/guest/:token", (c) => invalidLink(c));

  return app;
}

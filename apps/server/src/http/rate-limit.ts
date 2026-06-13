import type { Config } from "@canvas-drop/shared";
import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./types.js";

/**
 * Per-user + per-canvas rate limiting on every API class (§6.11.2, §12.3, M7).
 *
 * ONE broad middleware driven by a **path-first** classifier — NOT a per-route
 * list — so it automatically covers the M6 primitives and any AI/realtime HTTP
 * routes that land later. Keyed by the server-derived identity (`user.id`, set by
 * the gateway) and, for the runtime class, the path slug — never anything the
 * client sends (§12.0 #1), so a client cannot dodge or poison another's bucket.
 *
 * The store is a plain in-process fixed-window counter (§9.7 — single process,
 * no broker). A `RateLimitStore`-style interface is deliberately NOT introduced
 * (its only hypothetical second impl, Redis, is out of scope for every planned
 * milestone — scope review); a Redis store, if ever needed, is a small later
 * extraction.
 */

/** The shape the middleware depends on — exported only for test injection (fake clock). */
export interface RateLimitStore {
  hit(
    key: string,
    limit: number,
    windowMs: number,
  ): { allowed: boolean; remaining: number; resetAt: number; retryAfterSec: number };
}

/** Defensive cap on tracked keys — bounds the non-existent-slug-spray vector (the
 *  one realistic unbounded-key case, since the `canvas` class keys on the
 *  unvalidated path slug). Past it, the oldest-expiring bucket is evicted. */
const MAX_KEYS = 100_000;

/**
 * In-process fixed-window store. Each key holds a count + window reset time; an
 * expired window resets lazily on the next hit, and a periodic sweep prunes idle
 * keys. `now` is injectable so tests can advance the clock deterministically.
 */
export function inProcessRateLimitStore(now: () => number = Date.now): RateLimitStore {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  /** Reclaim genuinely-EXPIRED buckets. Returns true if it freed at least one.
   *  Never touches a live bucket — evicting a soonest-resetting live bucket would
   *  wipe another user's active counter (cross-user reset; code review). */
  const reclaimExpired = (ts: number): boolean => {
    let freed = false;
    for (const [k, b] of buckets) {
      if (b.resetAt <= ts) {
        buckets.delete(k);
        freed = true;
      }
    }
    return freed;
  };

  return {
    hit(key, limit, windowMs) {
      const ts = now();
      let b = buckets.get(key);
      if (!b || b.resetAt <= ts) {
        if (!b && buckets.size >= MAX_KEYS && !reclaimExpired(ts)) {
          // At the cap with nothing expired: fail OPEN for this request rather
          // than evict a live bucket. A spray that fills 100k keys is noisy and
          // attributable on the trusted-org model — never silently wipe a victim.
          return { allowed: true, remaining: limit - 1, resetAt: ts + windowMs, retryAfterSec: 1 };
        }
        b = { count: 0, resetAt: ts + windowMs };
        buckets.set(key, b);
      }
      b.count += 1;
      const allowed = b.count <= limit;
      const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - ts) / 1000));
      return {
        allowed,
        remaining: Math.max(0, limit - b.count),
        resetAt: b.resetAt,
        retryAfterSec,
      };
    },
  };
}

type RouteClass = "ai" | "canvas" | "management";

interface Classification {
  cls: RouteClass;
  key: string;
  limit: number;
  /** Envelope shape: runtime classes use { code }, management uses { error }. */
  runtime: boolean;
}

/**
 * Pure, **path-first** classifier. `role` does NOT distinguish `/api/*` from the
 * SPA (resolveRequest makes both `dashboard`), so we key off the path; `user.id`/
 * `canvasSlug` only build the bucket key. Returns null for non-API classes
 * (static content, SPA shell, sdk, healthz, auth) — they are not throttled here.
 */
export function classifyRequest(c: Context<AppEnv>, config: Config): Classification | null {
  const path = c.req.path;
  const userId = c.get("user")?.id;
  if (!userId) return null; // unauthenticated paths aren't reached past the gateway
  const rl = config.rateLimit;

  // Runtime canvas API: /v1/c/<slug>/...
  const runtimeMatch = path.match(/^\/v1\/c\/([^/]+)(\/|$)/);
  if (runtimeMatch) {
    // Key on the PATH slug (what canvasApiRoutes authorizes), NOT the host-derived
    // `canvasSlug` — in subdomain mode the latter is the host subdomain, so the
    // per-canvas bucket would be attributed to the wrong canvas (code review).
    const slug = runtimeMatch[1];
    // AI is the stricter sub-class (auto-applies when the AI primitive lands).
    if (/^\/v1\/c\/[^/]+\/ai(\/|$)/.test(path)) {
      return { cls: "ai", key: `ai:${userId}`, limit: rl.aiPerMin, runtime: true };
    }
    return {
      cls: "canvas",
      key: `canvas:${userId}:${slug}`,
      limit: rl.canvasApiPerMin,
      runtime: true,
    };
  }

  // Management API (includes /api/me, /api/canvases, /api/admin, session deploys).
  if (path.startsWith("/api/")) {
    return { cls: "management", key: `mgmt:${userId}`, limit: rl.managementPerMin, runtime: false };
  }

  return null; // canvas content, SPA shell, /sdk, /healthz — not API classes
}

const WINDOW_MS = 60_000;

/**
 * The broad rate-limit middleware. Mount AFTER the gateway + role middleware so
 * `user`/`canvasSlug` are server-resolved, and before the route handlers. On
 * breach: 429 + `Retry-After` + `X-RateLimit-*`, with the surface-consistent
 * envelope.
 */
export function rateLimit(store: RateLimitStore, config: Config): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!config.rateLimit.enabled) return next();
    const hit = classifyRequest(c, config);
    if (!hit) return next();

    const r = store.hit(hit.key, hit.limit, WINDOW_MS);
    c.header("X-RateLimit-Limit", String(hit.limit));
    c.header("X-RateLimit-Remaining", String(r.remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(r.resetAt / 1000)));
    if (!r.allowed) {
      c.header("Retry-After", String(r.retryAfterSec));
      return hit.runtime
        ? c.json({ code: "RATE_LIMITED" }, 429)
        : c.json({ error: "rate_limited" }, 429);
    }
    return next();
  });
}

/**
 * Standalone limiter for the mount points OUTSIDE the broad middleware (the
 * pre-gateway Bearer deploy API, login, password-gate). Returns whether the hit
 * is allowed + the retry-after; the caller decides the response shape. Keeps the
 * same store so all classes share one bound.
 */
export function takeToken(
  store: RateLimitStore,
  key: string,
  limit: number,
): { allowed: boolean; retryAfterSec: number } {
  const r = store.hit(key, limit, WINDOW_MS);
  return { allowed: r.allowed, retryAfterSec: r.retryAfterSec };
}

import { Buffer } from "node:buffer";
import type { Config } from "@canvas-drop/shared";
import type { Json } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { requireCapability } from "../canvas/capability-guard.js";
import { KvNotNumericError, type KvRepository } from "../db/repositories/kv.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import type { AppEnv } from "../http/types.js";

/** KV limits (§6.4.3–5). */
export const KV_MAX_VALUE_BYTES = 64 * 1024;
export const KV_MAX_KEY_BYTES = 512;
export const KV_MAX_KEYS_SHARED = 10_000;
export const KV_MAX_KEYS_USER = 1_000;

export interface CanvasKvDeps {
  config: Config;
  kv: KvRepository;
  usage: UsageEventsRepository;
}

/**
 * KV primitive routes (§6.4, plan 007 / M6), mounted at `/v1/c/:slug/kv`. Behind
 * `requireCapability("kv")`. `kv.*` uses the shared scope; `kv/user/*` forces the
 * caller's userId as scope (derived server-side, never client-supplied). Every op
 * records a `kv_op` usage event (fire-and-forget).
 */
export function canvasKvRoutes(deps: CanvasKvDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireCapability("kv", deps.config));

  // `canvas` is guaranteed set by the upstream resolve middleware (canvas-api.ts).
  const canvasId = (c: Context<AppEnv>) => {
    const cv = c.get("canvas");
    if (!cv) throw new Error("canvas not resolved");
    return cv.id;
  };
  const meter = (c: Context<AppEnv>, op: string) => {
    void deps.usage
      .record({ canvasId: canvasId(c), userId: c.get("user").id, type: "kv_op", meta: { op } })
      .catch(() => {});
  };

  /** Reject a new key that would exceed the per-scope key-count limit (§6.4.5). */
  async function overKeyLimit(cId: string, scope: string, key: string): Promise<boolean> {
    const exists = (await deps.kv.get(cId, scope, key)) !== null;
    if (exists) return false; // updates don't count against the limit
    const limit = scope === "shared" ? KV_MAX_KEYS_SHARED : KV_MAX_KEYS_USER;
    return (await deps.kv.countKeys(cId, scope)) >= limit;
  }

  function registerScope(prefix: string, scopeOf: (c: Context<AppEnv>) => string) {
    const listPath = prefix === "" ? "/" : prefix;

    app.get(listPath, async (c) => {
      const scope = scopeOf(c);
      const limitQ = c.req.query("limit");
      const res = await deps.kv.list(canvasId(c), scope, {
        prefix: c.req.query("prefix") ?? undefined,
        cursor: c.req.query("cursor") ?? undefined,
        limit: limitQ ? Number(limitQ) : undefined,
      });
      meter(c, "list");
      return c.json(res);
    });

    app.get(`${prefix}/:key`, async (c) => {
      const value = await deps.kv.get(canvasId(c), scopeOf(c), c.req.param("key"));
      meter(c, "get");
      if (value === null) return c.json({ error: "not_found" }, 404);
      return c.json({ value });
    });

    app.put(`${prefix}/:key`, async (c) => {
      const key = c.req.param("key");
      if (Buffer.byteLength(key) > KV_MAX_KEY_BYTES) {
        return c.json({ code: "KEY_TOO_LARGE" }, 413);
      }
      let value: Json;
      try {
        value = (await c.req.json()) as Json;
      } catch {
        return c.json({ error: "invalid_body" }, 400);
      }
      if (Buffer.byteLength(JSON.stringify(value ?? null)) > KV_MAX_VALUE_BYTES) {
        return c.json({ code: "VALUE_TOO_LARGE" }, 413);
      }
      const scope = scopeOf(c);
      if (await overKeyLimit(canvasId(c), scope, key)) return c.json({ code: "KEY_LIMIT" }, 409);
      await deps.kv.set(canvasId(c), scope, key, value, c.get("user").id);
      meter(c, "set");
      return c.json({ ok: true });
    });

    app.delete(`${prefix}/:key`, async (c) => {
      await deps.kv.delete(canvasId(c), scopeOf(c), c.req.param("key"));
      meter(c, "delete");
      return c.json({ ok: true });
    });

    app.post(`${prefix}/:key/increment`, async (c) => {
      const key = c.req.param("key");
      if (Buffer.byteLength(key) > KV_MAX_KEY_BYTES) {
        return c.json({ code: "KEY_TOO_LARGE" }, 413);
      }
      const body = (await c.req.json().catch(() => ({}))) as { by?: unknown };
      const by = typeof body.by === "number" ? body.by : 1;
      const scope = scopeOf(c);
      if (await overKeyLimit(canvasId(c), scope, key)) return c.json({ code: "KEY_LIMIT" }, 409);
      try {
        const value = await deps.kv.increment(canvasId(c), scope, key, by, c.get("user").id);
        meter(c, "increment");
        return c.json({ value });
      } catch (err) {
        if (err instanceof KvNotNumericError) return c.json({ code: "NOT_NUMERIC" }, 409);
        throw err;
      }
    });
  }

  // Register the user scope first (static `/user` segment) then the shared scope.
  registerScope("/user", (c) => c.get("user").id);
  registerScope("", () => "shared");

  return app;
}

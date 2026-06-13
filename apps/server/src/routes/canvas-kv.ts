import { Buffer } from "node:buffer";
import type { Config } from "@canvas-drop/shared";
import type { Json } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import type { QuotaResolver } from "../admin/settings-service.js";
import type { AuditLog } from "../audit/audit-log.js";
import { requireCapability } from "../canvas/capability-guard.js";
import { KvNotNumericError, type KvRepository } from "../db/repositories/kv.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import { requireCanvas } from "../http/canvas-api-isolation.js";
import type { AppEnv } from "../http/types.js";

/** KV limits (§6.4.3–5). The key-count limits are admin-tunable defaults (M7). */
export const KV_MAX_VALUE_BYTES = 64 * 1024;
export const KV_MAX_KEY_BYTES = 512;
export const KV_MAX_KEYS_SHARED = 10_000;
export const KV_MAX_KEYS_USER = 1_000;

export interface CanvasKvDeps {
  config: Config;
  kv: KvRepository;
  usage: UsageEventsRepository;
  /** Audit sink (M7) — KV mutations recorded for the §12.1.8 security trail. */
  audit?: AuditLog;
  /** Admin-tunable quota resolver (M7). Absent → the hard constants above. */
  quota?: QuotaResolver;
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

  const canvasId = (c: Context<AppEnv>) => requireCanvas(c).id;
  const meter = (c: Context<AppEnv>, op: string) => {
    void deps.usage
      .record({ canvasId: canvasId(c), userId: c.get("user").id, type: "kv_op", meta: { op } })
      .catch(() => {});
  };
  // Audit (security trail, §12.1.8) — distinct from `meter` (metering for stats).
  // Only MUTATIONS are audited (set/delete/increment); reads are not (volume).
  const auditMutation = (c: Context<AppEnv>, op: string, scope: string) => {
    deps.audit?.recordAudit({
      action: "kv_mutation",
      actorId: c.get("user").id,
      targetId: canvasId(c),
      meta: { op, scope: scope === "shared" ? "shared" : "user" },
    });
  };

  /** Reject a new key that would exceed the per-scope key-count limit (§6.4.5).
   *  The limit is the admin-tunable global default (M7) with the hard constant as
   *  the fallback when no resolver/override is present. */
  async function overKeyLimit(cId: string, scope: string, key: string): Promise<boolean> {
    const exists = (await deps.kv.get(cId, scope, key)) !== null;
    if (exists) return false; // updates don't count against the limit
    const fallback = scope === "shared" ? KV_MAX_KEYS_SHARED : KV_MAX_KEYS_USER;
    const quotaKey = scope === "shared" ? "kv.keys.shared" : "kv.keys.user";
    const limit = deps.quota ? await deps.quota(quotaKey, fallback) : fallback;
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
      if (value === null) return c.json({ code: "NOT_FOUND" }, 404);
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
        return c.json({ code: "INVALID_BODY" }, 400);
      }
      if (Buffer.byteLength(JSON.stringify(value ?? null)) > KV_MAX_VALUE_BYTES) {
        return c.json({ code: "VALUE_TOO_LARGE" }, 413);
      }
      const scope = scopeOf(c);
      if (await overKeyLimit(canvasId(c), scope, key)) return c.json({ code: "KEY_LIMIT" }, 409);
      await deps.kv.set(canvasId(c), scope, key, value, c.get("user").id);
      meter(c, "set");
      auditMutation(c, "set", scope);
      return c.json({ ok: true });
    });

    app.delete(`${prefix}/:key`, async (c) => {
      const scope = scopeOf(c);
      await deps.kv.delete(canvasId(c), scope, c.req.param("key"));
      meter(c, "delete");
      auditMutation(c, "delete", scope);
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
        auditMutation(c, "increment", scope);
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

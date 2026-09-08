import { Buffer } from "node:buffer";
import type { Json } from "@canvas-drop/shared/db";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireCapability } from "../canvas/capability-guard.js";
import { canEditRuntime, permissionDenied } from "../canvas/runtime-permissions.js";
import { requireCanvas } from "../http/canvas-api-isolation.js";
import type { AppEnv } from "../http/types.js";
import {
  type CanvasKvDeps,
  KV_MAX_KEYS_SHARED,
  KV_MAX_KEYS_USER,
  KV_MAX_VALUE_BYTES,
} from "./canvas-kv.js";

type StoredSubmission = { value: Json; updatedAt: number };

/** Reviewable input, distinct from shared content and private personal preferences. */
export function canvasSubmissionRoutes(deps: CanvasKvDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireCapability("kv", deps.config));
  app.use(
    "*",
    bodyLimit({
      maxSize: KV_MAX_VALUE_BYTES,
      onError: (c) => c.json({ code: "VALUE_TOO_LARGE" }, 413),
    }),
  );
  const validateCollection: MiddlewareHandler<AppEnv> = async (c, next) => {
    const collection = c.req.param("collection");
    if (!collection || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(collection)) {
      return c.json(
        {
          code: "INVALID_BODY",
          message:
            "collection must contain 1–80 letters, digits, dots, underscores or hyphens and start with a letter or digit",
        },
        400,
      );
    }
    c.header("Cache-Control", "private, no-store");
    await next();
  };
  app.use("/:collection", validateCollection);
  app.use("/:collection/*", validateCollection);
  const scope = (c: Context<AppEnv>) => `submissions:${c.req.param("collection")}`;
  const meter = (c: Context<AppEnv>, op: string, mutation = false) => {
    const canvasId = requireCanvas(c).id;
    const userId = c.get("user").id;
    void deps.usage.record({ canvasId, userId, type: "kv_op", meta: { op } }).catch(() => {});
    if (mutation)
      deps.audit?.recordAudit({
        action: "kv_mutation",
        actorId: userId,
        targetId: canvasId,
        meta: { op, scope: "submissions", collection: c.req.param("collection") ?? "" },
      });
  };
  const entry = (userId: string, value: Json) => ({ userId, ...(value as StoredSubmission) });

  app.get("/:collection/mine", async (c) => {
    const row = await deps.kv.find(requireCanvas(c).id, scope(c), c.get("user").id);
    meter(c, "submission_get");
    return row ? c.json(entry(c.get("user").id, row.value)) : c.json({ code: "NOT_FOUND" }, 404);
  });
  app.put("/:collection/mine", async (c) => {
    let value: Json;
    try {
      value = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_BODY" }, 400);
    }
    if (Buffer.byteLength(JSON.stringify(value)) > KV_MAX_VALUE_BYTES)
      return c.json({ code: "VALUE_TOO_LARGE" }, 413);
    const canvasId = requireCanvas(c).id;
    const userId = c.get("user").id;
    if (!(await deps.kv.find(canvasId, scope(c), userId))) {
      const sharedLimit = deps.quota
        ? await deps.quota("kv.keys.shared", KV_MAX_KEYS_SHARED)
        : KV_MAX_KEYS_SHARED;
      const userLimit = deps.quota
        ? await deps.quota("kv.keys.user", KV_MAX_KEYS_USER)
        : KV_MAX_KEYS_USER;
      if (
        (await deps.kv.countSubmissions(canvasId)) >= sharedLimit ||
        (await deps.kv.countSubmissions(canvasId, userId)) >= userLimit
      ) {
        return c.json({ code: "KEY_LIMIT" }, 409);
      }
    }
    // Caller-supplied userId/updatedAt, if present inside value, are ordinary data.
    const stored = { value, updatedAt: Date.now() };
    await deps.kv.set(canvasId, scope(c), userId, stored, userId);
    meter(c, "submission_set", true);
    return c.json({ userId, ...stored });
  });
  app.delete("/:collection/mine", async (c) => {
    await deps.kv.delete(requireCanvas(c).id, scope(c), c.get("user").id);
    meter(c, "submission_withdraw", true);
    return c.json({ ok: true });
  });
  app.get("/:collection", async (c) => {
    if (!canEditRuntime(c)) return permissionDenied(c, "review submissions");
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    const cursor = c.req.query("cursor");
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (cursor !== undefined && (cursor.length > 128 || !/^[a-zA-Z0-9:-]+$/.test(cursor)))
    ) {
      return c.json({ code: "INVALID_BODY", message: "invalid pagination" }, 400);
    }
    const page = await deps.kv.list(requireCanvas(c).id, scope(c), { limit, cursor });
    meter(c, "submission_list");
    return c.json({
      entries: page.entries.map((row) => entry(row.key, row.value)),
      nextCursor: page.nextCursor,
    });
  });
  app.delete("/:collection", async (c) => {
    if (!canEditRuntime(c)) return permissionDenied(c, "clear submissions");
    await deps.kv.clearSubmissions(requireCanvas(c).id, c.req.param("collection"));
    meter(c, "submissions_clear", true);
    return c.json({ ok: true });
  });
  app.delete("/:collection/:userId", async (c) => {
    if (!canEditRuntime(c)) return permissionDenied(c, "manage submissions");
    const userId = c.req.param("userId");
    if (!/^[a-zA-Z0-9:-]{1,128}$/.test(userId)) return c.json({ code: "INVALID_BODY" }, 400);
    await deps.kv.delete(requireCanvas(c).id, scope(c), userId);
    meter(c, "submission_remove", true);
    return c.json({ ok: true });
  });
  return app;
}

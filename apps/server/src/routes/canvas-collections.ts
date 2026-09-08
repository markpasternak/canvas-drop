import {
  authorFilter,
  type DataOperation,
  dataPermissions,
  dataRules,
  parseRuntimePolicy,
  resourceNameSchema,
  rightAllows,
} from "@canvas-drop/shared";
import type { Json } from "@canvas-drop/shared/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { v7 as uuidv7 } from "uuid";
import { requireCapability } from "../canvas/capability-guard.js";
import type { FilesService } from "../canvas/files-service.js";
import { permissionDenied } from "../canvas/runtime-permissions.js";
import { requireCanvas } from "../http/canvas-api-isolation.js";
import type { AppEnv } from "../http/types.js";
import {
  type CanvasKvDeps,
  KV_MAX_KEYS_SHARED,
  KV_MAX_KEYS_USER,
  KV_MAX_VALUE_BYTES,
} from "./canvas-kv.js";

/** Authored records live in reserved KV scopes, inaccessible via raw KV endpoints. */
export function canvasCollectionRoutes(deps: CanvasKvDeps & { files?: FilesService }) {
  const app = new Hono<AppEnv>();
  app.use("*", requireCapability("kv", deps.config));
  app.use(
    "*",
    bodyLimit({
      maxSize: KV_MAX_VALUE_BYTES,
      onError: (c) => c.json({ code: "VALUE_TOO_LARGE" }, 413),
    }),
  );
  const collection = (c: Context<AppEnv>) => c.req.param("collection") ?? "";
  const policy = (c: Context<AppEnv>) =>
    parseRuntimePolicy(requireCanvas(c).runtimePolicy).collections[collection(c)];
  const requirePolicy = (c: Context<AppEnv>) => {
    const value = policy(c);
    if (!value) throw new Error("Collection middleware invariant");
    return value;
  };
  const filter = (c: Context<AppEnv>, op: DataOperation) =>
    authorFilter(
      dataRules(requirePolicy(c))[op],
      c.get("runtimeRole") ?? "viewer",
      c.get("user").id,
    );
  const validate: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    if (!resourceNameSchema.safeParse(collection(c)).success)
      return c.json({ code: "INVALID_BODY" }, 400);
    if (!policy(c)) return c.json({ code: "COLLECTION_NOT_CONFIGURED" }, 404);
    await next();
  };
  app.use("/:collection", validate);
  app.use("/:collection/*", validate);
  const meter = (c: Context<AppEnv>, op: string, mutation = false) => {
    const canvasId = requireCanvas(c).id;
    const actorId = c.get("user").id;
    void deps.usage
      .record({ canvasId, userId: actorId, type: "kv_op", meta: { op, collection: collection(c) } })
      .catch(() => {});
    if (mutation)
      deps.audit?.recordAudit({
        action: "kv_mutation",
        actorId,
        targetId: canvasId,
        meta: { op, scope: "collection", collection: collection(c) },
      });
  };
  const record = (c: Context<AppEnv>) =>
    deps.kv.getRecord(requireCanvas(c).id, collection(c), c.req.param("id") ?? "");
  async function cleanupAttachments(c: Context<AppEnv>, ids: string[]): Promise<number> {
    if (!deps.files || ids.length === 0) return 0;
    const deleted = new Set(ids);
    const files = await deps.files.list(requireCanvas(c).id);
    const attached = files.filter(
      (file) =>
        file.scope === `record:${collection(c)}` && file.recordId && deleted.has(file.recordId),
    );
    const service = deps.files;
    const outcomes = await Promise.allSettled(
      attached.map((file) => service.delete(requireCanvas(c).id, file.id)),
    );
    return outcomes.filter((outcome) => outcome.status === "rejected").length;
  }
  const allowed = (c: Context<AppEnv>, op: DataOperation, authorId?: string) =>
    rightAllows(
      dataRules(requirePolicy(c))[op],
      c.get("runtimeRole") ?? "viewer",
      c.get("user").id,
      authorId,
    );

  app.get("/:collection/permissions", (c) => {
    const role = c.get("runtimeRole") ?? "viewer";
    const actor = c.get("user").id;
    return c.json(dataPermissions(requirePolicy(c), role, actor));
  });
  app.get("/:collection/count", async (c) => {
    if (
      !rightAllows(
        requirePolicy(c).aggregateCount ?? "none",
        c.get("runtimeRole") ?? "viewer",
        c.get("user").id,
      )
    )
      return permissionDenied(c, "read aggregate count");
    meter(c, "collection_count");
    return c.json({ count: await deps.kv.countRecords(requireCanvas(c).id, collection(c)) });
  });
  app.get("/:collection", async (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const cursor = c.req.query("cursor");
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (cursor !== undefined && !/^[a-zA-Z0-9-]{1,80}$/.test(cursor))
    )
      return c.json({ code: "INVALID_BODY" }, 400);
    if (filter(c, "read") === false) return permissionDenied(c, "list records");
    meter(c, "collection_list");
    return c.json(
      await deps.kv.listRecords(
        requireCanvas(c).id,
        collection(c),
        filter(c, "read"),
        limit,
        cursor,
      ),
    );
  });
  app.post("/:collection", async (c) => {
    if (!allowed(c, "create")) return permissionDenied(c, "create records");
    let value: Json;
    try {
      value = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_BODY" }, 400);
    }
    const canvasId = requireCanvas(c).id;
    const actor = c.get("user").id;
    const sharedMax = deps.quota
      ? await deps.quota("kv.keys.shared", KV_MAX_KEYS_SHARED)
      : KV_MAX_KEYS_SHARED;
    const userMax = deps.quota
      ? await deps.quota("kv.keys.user", KV_MAX_KEYS_USER)
      : KV_MAX_KEYS_USER;
    if (
      (await deps.kv.countRecords(canvasId)) >= sharedMax ||
      (await deps.kv.countRecords(canvasId, undefined, actor)) >= userMax
    )
      return c.json({ code: "KEY_LIMIT" }, 409);
    const row = await deps.kv.createRecord(canvasId, collection(c), uuidv7(), value, actor);
    meter(c, "collection_create", true);
    return c.json(row, 201);
  });
  app.get("/:collection/:id", async (c) => {
    const row = await record(c);
    if (!row || !allowed(c, "read", row.authorId)) return c.json({ code: "NOT_FOUND" }, 404);
    meter(c, "collection_get");
    return c.json(row);
  });
  app.put("/:collection/:id", async (c) => {
    const row = await record(c);
    if (!row || !allowed(c, "read", row.authorId)) return c.json({ code: "NOT_FOUND" }, 404);
    if (!allowed(c, "update", row.authorId)) return permissionDenied(c, "update records");
    let value: Json;
    try {
      value = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_BODY" }, 400);
    }
    const updated = await deps.kv.updateRecord(
      requireCanvas(c).id,
      collection(c),
      row.id,
      value,
      c.get("user").id,
      filter(c, "update"),
    );
    if (!updated) return c.json({ code: "NOT_FOUND" }, 404);
    meter(c, "collection_update", true);
    return c.json(updated);
  });
  app.post("/:collection/:id/increment", async (c) => {
    const row = await record(c);
    if (!row || !allowed(c, "read", row.authorId)) return c.json({ code: "NOT_FOUND" }, 404);
    if (!allowed(c, "increment", row.authorId)) return permissionDenied(c, "increment records");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.by !== "number" || !Number.isFinite(body.by))
      return c.json({ code: "INVALID_BODY" }, 400);
    const updated = await deps.kv.incrementRecord(
      requireCanvas(c).id,
      collection(c),
      row.id,
      body.by,
      c.get("user").id,
      filter(c, "increment"),
    );
    if (!updated) return c.json({ code: "NOT_NUMERIC" }, 409);
    meter(c, "collection_increment", true);
    return c.json(updated);
  });
  app.delete("/:collection/:id", async (c) => {
    const row = await record(c);
    if (!row || !allowed(c, "read", row.authorId)) return c.json({ code: "NOT_FOUND" }, 404);
    if (!allowed(c, "delete", row.authorId)) return permissionDenied(c, "delete records");
    const ids = await deps.kv.deleteRecords(
      requireCanvas(c).id,
      collection(c),
      filter(c, "delete"),
      row.id,
    );
    const attachmentCleanupFailed = await cleanupAttachments(c, ids);
    meter(c, "collection_delete", true);
    return c.json({ ok: true, attachmentCleanupFailed });
  });
  app.delete("/:collection", async (c) => {
    // Intersect read and delete, so bulk cannot mutate records unavailable individually.
    const read = filter(c, "read"),
      remove = filter(c, "delete");
    if (read === false || remove === false) return permissionDenied(c, "delete records");
    const ids = await deps.kv.deleteRecords(requireCanvas(c).id, collection(c), read ?? remove);
    const attachmentCleanupFailed = await cleanupAttachments(c, ids);
    meter(c, "collection_clear", true);
    return c.json({ deleted: ids.length, attachmentCleanupFailed });
  });
  return app;
}

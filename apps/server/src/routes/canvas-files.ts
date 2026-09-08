import {
  type Config,
  type DataOperation,
  dataRules,
  parseRuntimePolicy,
  type RuntimePolicy,
  resourceNameSchema,
  rightAllows,
} from "@canvas-drop/shared";
import type { FileRow } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AuditLog } from "../audit/audit-log.js";
import { requireCapability } from "../canvas/capability-guard.js";
import { safeServeHeaders } from "../canvas/file-serving.js";
import { FilesQuotaError, type FilesService, FileTooLargeError } from "../canvas/files-service.js";
import { canEditRuntime, permissionDenied } from "../canvas/runtime-permissions.js";
import type { KvRepository } from "../db/repositories/kv.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import { requireCanvas } from "../http/canvas-api-isolation.js";
import type { AppEnv } from "../http/types.js";
import { blobBodyLimit } from "./deploy-common.js";

export interface CanvasFilesDeps {
  config: Config;
  files: FilesService;
  usage: UsageEventsRepository;
  /** Audit sink (M7) — file upload/delete recorded for the §12.1.8 security trail. */
  audit?: AuditLog;
  kv?: KvRepository;
}

/**
 * Files primitive routes (§6.5, plan 007 / M6), mounted at `/v1/c/:slug/files`.
 * Behind `requireCapability("files")`. Content is served buffer-mode (KTD-5) with
 * the safe-headers helper (nosniff; inline only for safe rasters; SVG forced to
 * attachment; filename sanitized). Every op records a `file_op` usage event.
 */
export function canvasFilesRoutes(deps: CanvasFilesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireCapability("files", deps.config));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });

  const canvas = (c: Context<AppEnv>) => requireCanvas(c);
  const fileAllows = async (
    c: Context<AppEnv>,
    file: Pick<FileRow, "scope" | "recordId" | "uploadedBy">,
    op: DataOperation,
    lookup?: { policies: RuntimePolicy; authors: Map<string, string> },
  ) => {
    const policies = lookup?.policies ?? parseRuntimePolicy(canvas(c).runtimePolicy);
    const actor = c.get("user").id;
    const role = c.get("runtimeRole") ?? "viewer";
    if (file.scope === "shared") return op === "read" || canEditRuntime(c);
    if (file.scope === "submission") return canEditRuntime(c) || file.uploadedBy === actor;
    if (file.scope.startsWith("group:")) {
      const policy = policies.fileGroups[file.scope.slice(6)];
      return !!policy && rightAllows(dataRules(policy)[op], role, actor, file.uploadedBy);
    }
    if (file.scope.startsWith("record:") && file.recordId && deps.kv) {
      if (!canvas(c).capKv) return false;
      const name = file.scope.slice(7);
      const policy = policies.collections[name];
      if (!policy) return false;
      const author = lookup
        ? lookup.authors.get(`${file.scope}/${file.recordId}`)
        : (await deps.kv.getRecord(canvas(c).id, name, file.recordId))?.authorId;
      return !!author && rightAllows(dataRules(policy)[op], role, actor, author);
    }
    return false;
  };
  const meter = (c: Context<AppEnv>, op: string) => {
    void deps.usage
      .record({ canvasId: canvas(c).id, userId: c.get("user").id, type: "file_op", meta: { op } })
      .catch(() => {});
  };

  app.post("/", blobBodyLimit, async (c) => {
    const cv = canvas(c);
    let file: unknown;
    let scope: string;
    let recordId: string | undefined;
    try {
      const data = await c.req.formData();
      file = data.get("file");
      const requestedScope = data.get("scope") ?? "shared";
      if (requestedScope !== "shared" && requestedScope !== "submission")
        return c.json({ code: "INVALID_BODY" }, 400);
      scope = requestedScope;
      const group = data.get("group");
      const collection = data.get("collection");
      const record = data.get("recordId");
      if (
        (group && collection) ||
        ((group || collection) && data.has("scope")) ||
        (record && !collection)
      )
        return c.json({ code: "INVALID_BODY" }, 400);
      if (group || collection) {
        const name = group ?? collection;
        if (!resourceNameSchema.safeParse(name).success)
          return c.json({ code: "INVALID_BODY" }, 400);
        scope = group ? `group:${name}` : `record:${name}`;
        if (collection) {
          if (typeof record !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(record))
            return c.json({ code: "INVALID_BODY" }, 400);
          recordId = record;
        }
      }
    } catch {
      return c.json({ code: "INVALID_BODY" }, 400);
    }
    const candidate = { scope, recordId: recordId ?? null, uploadedBy: c.get("user").id };
    if (
      !(await fileAllows(c, candidate, scope.startsWith("record:") ? "update" : "create")) ||
      (scope.startsWith("record:") && !(await fileAllows(c, candidate, "read")))
    )
      return permissionDenied(c, "upload files");
    if (!(file instanceof File)) return c.json({ code: "INVALID_BODY" }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const row = await deps.files.create({
        canvasId: cv.id,
        filename: file.name || "upload",
        mime: file.type || "application/octet-stream",
        bytes,
        userId: c.get("user").id,
        scope,
        recordId,
      });
      // A parent can be deleted while the upload is in flight. Do not retain an orphan.
      if (scope.startsWith("record:") && !(await fileAllows(c, candidate, "read"))) {
        await deps.files.delete(cv.id, row.id);
        return c.json({ code: "NOT_FOUND" }, 404);
      }
      meter(c, "upload");
      deps.audit?.recordAudit({
        action: "file_upload",
        actorId: c.get("user").id,
        targetId: cv.id,
        meta: { fileId: row.id, size: row.sizeBytes },
      });
      return c.json(
        {
          id: row.id,
          name: row.filename,
          size: row.sizeBytes,
          url: `/v1/c/${cv.slug}/files/${row.id}/content`,
        },
        201,
      );
    } catch (err) {
      if (err instanceof FileTooLargeError) return c.json({ code: err.code }, 413);
      if (err instanceof FilesQuotaError) return c.json({ code: err.code }, 409);
      throw err;
    }
  });

  app.get("/", async (c) => {
    const candidates = await deps.files.list(canvas(c).id);
    const policies = parseRuntimePolicy(canvas(c).runtimePolicy);
    const authors = new Map<string, string>();
    if (deps.kv && canvas(c).capKv) {
      const parents = new Map<string, string[]>();
      for (const file of candidates) {
        if (!file.scope.startsWith("record:") || !file.recordId) continue;
        const name = file.scope.slice(7);
        if (!Object.hasOwn(policies.collections, name)) continue;
        const ids = parents.get(name) ?? [];
        ids.push(file.recordId);
        parents.set(name, ids);
      }
      for (const [name, ids] of parents) {
        for (const record of await deps.kv.getRecordsByIds(canvas(c).id, name, ids)) {
          authors.set(`record:${name}/${record.id}`, record.authorId);
        }
      }
    }
    const visibility = await Promise.all(
      candidates.map((file) => fileAllows(c, file, "read", { policies, authors })),
    );
    const rows = candidates.filter((_, index) => visibility[index]);
    meter(c, "list");
    return c.json({
      files: rows.map((r) => ({
        id: r.id,
        name: r.filename,
        size: r.sizeBytes,
        mime: r.mime,
        createdAt: r.createdAt,
        scope: r.scope,
        uploadedBy: r.uploadedBy,
        recordId: r.recordId,
      })),
    });
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const file = await deps.files.metadata(canvas(c).id, id);
    if (!file || !(await fileAllows(c, file, "read"))) return c.json({ code: "NOT_FOUND" }, 404);
    if (!(await fileAllows(c, file, "delete"))) return permissionDenied(c, "delete files");
    const ok = await deps.files.delete(canvas(c).id, id);
    meter(c, "delete");
    if (!ok) return c.json({ code: "NOT_FOUND" }, 404);
    deps.audit?.recordAudit({
      action: "file_delete",
      actorId: c.get("user").id,
      targetId: canvas(c).id,
      meta: { fileId: id },
    });
    return c.json({ ok: true });
  });

  app.get("/:id/content", async (c) => {
    const file = await deps.files.metadata(canvas(c).id, c.req.param("id"));
    if (!file || !(await fileAllows(c, file, "read"))) return c.json({ code: "NOT_FOUND" }, 404);
    const got = await deps.files.content(canvas(c).id, file.id);
    if (!got) return c.json({ code: "NOT_FOUND" }, 404);
    meter(c, "download");
    // Set the safe-serve headers via the Hono context (NOT a raw `new Response`),
    // so the credentialed CORS headers the isolation middleware already applied
    // (§9.4) survive onto the response. A raw Response would drop them, which
    // CORS-blocks any cross-origin `fetch()` of file content in subdomain mode —
    // e.g. an SDK canvas reading its own files via `canvasdrop.files.url(id)`.
    for (const [k, v] of Object.entries(safeServeHeaders(got.row.mime, got.row.filename))) {
      c.header(k, v);
    }
    c.header("Cache-Control", "private, no-store");
    return c.body(new Uint8Array(got.bytes));
  });

  app.patch("/:id", async (c) => {
    const file = await deps.files.metadata(canvas(c).id, c.req.param("id"));
    if (!file || !(await fileAllows(c, file, "read"))) return c.json({ code: "NOT_FOUND" }, 404);
    if (!(await fileAllows(c, file, "update"))) return permissionDenied(c, "rename files");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > 255)
      return c.json({ code: "INVALID_BODY" }, 400);
    await deps.files.rename(canvas(c).id, file.id, body.name.trim());
    meter(c, "rename");
    deps.audit?.recordAudit({
      action: "file_upload",
      actorId: c.get("user").id,
      targetId: canvas(c).id,
      meta: { fileId: file.id, op: "rename" },
    });
    return c.json({ ok: true });
  });

  return app;
}

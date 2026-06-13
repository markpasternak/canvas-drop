import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { requireCapability } from "../canvas/capability-guard.js";
import { safeServeHeaders } from "../canvas/file-serving.js";
import { FilesQuotaError, type FilesService, FileTooLargeError } from "../canvas/files-service.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import type { AppEnv } from "../http/types.js";

export interface CanvasFilesDeps {
  config: Config;
  files: FilesService;
  usage: UsageEventsRepository;
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

  const canvas = (c: Context<AppEnv>): Canvas => {
    const cv = c.get("canvas");
    if (!cv) throw new Error("canvas not resolved");
    return cv;
  };
  const meter = (c: Context<AppEnv>, op: string) => {
    void deps.usage
      .record({ canvasId: canvas(c).id, userId: c.get("user").id, type: "file_op", meta: { op } })
      .catch(() => {});
  };

  app.post("/", async (c) => {
    const cv = canvas(c);
    let file: unknown;
    try {
      file = (await c.req.formData()).get("file");
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    if (!(file instanceof File)) return c.json({ error: "invalid_body" }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const row = await deps.files.create({
        canvasId: cv.id,
        filename: file.name || "upload",
        mime: file.type || "application/octet-stream",
        bytes,
        userId: c.get("user").id,
      });
      meter(c, "upload");
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
    const rows = await deps.files.list(canvas(c).id);
    meter(c, "list");
    return c.json({
      files: rows.map((r) => ({
        id: r.id,
        name: r.filename,
        size: r.sizeBytes,
        mime: r.mime,
        createdAt: r.createdAt,
      })),
    });
  });

  app.delete("/:id", async (c) => {
    const ok = await deps.files.delete(canvas(c).id, c.req.param("id"));
    meter(c, "delete");
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/:id/content", async (c) => {
    const got = await deps.files.content(canvas(c).id, c.req.param("id"));
    if (!got) return c.json({ error: "not_found" }, 404);
    meter(c, "download");
    return new Response(new Uint8Array(got.bytes), {
      headers: safeServeHeaders(got.row.mime, got.row.filename),
    });
  });

  return app;
}

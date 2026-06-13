import { Buffer } from "node:buffer";
import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AuditLog } from "../audit/audit-log.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import { hashPassword } from "../canvas/password.js";
import { generateUniqueSlug } from "../canvas/slug.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { DeployEngine } from "../deploy/engine.js";
import { type DeployEntry, fromPasteHtml, fromZip } from "../deploy/ingest.js";
import { requireSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
import { deployResponse } from "./deploy-common.js";

export interface ManagementDeps {
  config: Config;
  canvases: CanvasesRepository;
  audit: AuditLog;
  engine: DeployEngine;
}

const createSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});

const settingsSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  shared: z.boolean().optional(),
  sharedExpiresAt: z.number().int().positive().nullable().optional(),
  password: z.string().min(1).nullable().optional(), // set, or null to clear
  spaFallback: z.boolean().optional(),
  galleryListed: z.boolean().optional(),
  gallerySummary: z.string().max(500).nullable().optional(),
  galleryTags: z.array(z.string()).optional(),
});

/** Public canvas view (never leaks `api_key_hash` / `password_hash`). */
function publicCanvas(config: Config, cv: Canvas) {
  return {
    id: cv.id,
    slug: cv.slug,
    url: canvasUrl(config, cv.slug),
    title: cv.title,
    description: cv.description,
    shared: cv.shared,
    sharedExpiresAt: cv.sharedExpiresAt,
    hasPassword: cv.passwordHash !== null,
    spaFallback: cv.spaFallback,
    galleryListed: cv.galleryListed,
    status: cv.status,
    currentVersionId: cv.currentVersionId,
    createdAt: cv.createdAt,
    updatedAt: cv.updatedAt,
  };
}

/**
 * Canvas lifecycle management API (§11.3), mounted at `/api/canvases`. Owner (or
 * admin) authenticated via the foundation gateway; same-origin enforced on
 * mutating routes. Deploy routes are added by U19.
 */
export function managementRoutes(deps: ManagementDeps) {
  const app = new Hono<AppEnv>();
  const sameOrigin = requireSameOrigin(deps.config);

  /** Load a canvas the caller may manage (owner or admin), else 404. */
  async function ownedCanvas(c: Context<AppEnv>): Promise<Canvas | null> {
    const id = c.req.param("id");
    if (!id) return null;
    const cv = await deps.canvases.findById(id);
    if (!cv || cv.status === "deleted") return null;
    const user = c.get("user");
    if (cv.ownerId !== user.id && !user.isAdmin) return null; // 404, don't confirm existence
    return cv;
  }

  // Create → slug + API key (shown once).
  app.post("/", sameOrigin, async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const user = c.get("user");
    const slug = await generateUniqueSlug(
      async (s) => (await deps.canvases.findBySlug(s)) !== null,
    );
    const apiKey = generateApiKey();
    const cv = await deps.canvases.create({
      ownerId: user.id,
      slug,
      apiKeyHash: hashApiKey(apiKey),
      title: body.data.title,
      description: body.data.description,
    });
    deps.audit.recordAudit({ action: "canvas_create", actorId: user.id, targetId: cv.id });
    // apiKey is returned ONCE and never again.
    return c.json({ ...publicCanvas(deps.config, cv), apiKey }, 201);
  });

  // List the caller's own canvases.
  app.get("/", async (c) => {
    const list = await deps.canvases.listByOwner(c.get("user").id);
    return c.json({ canvases: list.map((cv) => publicCanvas(deps.config, cv)) });
  });

  app.get("/:id", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    return c.json(publicCanvas(deps.config, cv));
  });

  app.patch("/:id/settings", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const body = settingsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const p = body.data;

    let updated = cv;
    const { password, ...rest } = p;
    if (Object.keys(rest).length > 0) {
      updated = await deps.canvases.updateSettings(cv.id, rest);
    }
    if (password !== undefined) {
      const hash = password === null ? null : await hashPassword(password);
      updated = await deps.canvases.setPassword(cv.id, hash);
      deps.audit.recordAudit({
        action: "password_change",
        actorId: c.get("user").id,
        targetId: cv.id,
        meta: { cleared: password === null },
      });
    }
    if (p.shared !== undefined) {
      deps.audit.recordAudit({
        action: "share_change",
        actorId: c.get("user").id,
        targetId: cv.id,
        meta: { shared: p.shared },
      });
    }
    return c.json(publicCanvas(deps.config, updated));
  });

  app.post("/:id/regenerate-slug", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const slug = await generateUniqueSlug(
      async (s) => (await deps.canvases.findBySlug(s)) !== null,
    );
    const updated = await deps.canvases.regenerateSlug(cv.id, slug);
    deps.audit.recordAudit({ action: "slug_regen", actorId: c.get("user").id, targetId: cv.id });
    return c.json(publicCanvas(deps.config, updated));
  });

  app.post("/:id/regenerate-key", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const apiKey = generateApiKey();
    await deps.canvases.regenerateApiKey(cv.id, hashApiKey(apiKey));
    deps.audit.recordAudit({ action: "key_regen", actorId: c.get("user").id, targetId: cv.id });
    return c.json({ apiKey }); // shown once
  });

  app.delete("/:id", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    await deps.canvases.setStatus(cv.id, "deleted");
    deps.audit.recordAudit({ action: "canvas_delete", actorId: c.get("user").id, targetId: cv.id });
    return c.json({ ok: true });
  });

  // --- Deploy entry points (UI calls these; the engine + result shape is U18/U19) ---

  // Paste-HTML quick create: create a canvas, then deploy a single index.html.
  app.post("/paste", sameOrigin, async (c) => {
    const body = z
      .object({ html: z.string().min(1), title: z.string().max(200).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const user = c.get("user");
    const slug = await generateUniqueSlug(
      async (s) => (await deps.canvases.findBySlug(s)) !== null,
    );
    const apiKey = generateApiKey();
    const cv = await deps.canvases.create({
      ownerId: user.id,
      slug,
      apiKeyHash: hashApiKey(apiKey),
      title: body.data.title,
    });
    deps.audit.recordAudit({ action: "canvas_create", actorId: user.id, targetId: cv.id });
    const res = await deployResponse(
      c,
      deps.engine,
      deps.audit,
      cv,
      "paste",
      fromPasteHtml(body.data.html),
      user.id,
    );
    // On success, fold in the canvas + once-shown key; on a deploy error pass it through.
    if (res.status >= 400) return res;
    const deploy = (await res.json()) as Record<string, unknown>;
    return c.json({ ...publicCanvas(deps.config, cv), apiKey, deploy }, 201);
  });

  app.post("/:id/deploy/zip", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.byteLength === 0) return c.json({ code: "EMPTY_DEPLOY", message: "empty body" }, 400);
    return deployResponse(c, deps.engine, deps.audit, cv, "zip", fromZip(buf), c.get("user").id);
  });

  app.post("/:id/deploy/folder", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    // Each multipart file field's KEY is the file's canvas-relative path.
    const form = await c.req.parseBody({ all: true });
    const entries: DeployEntry[] = [];
    for (const [path, value] of Object.entries(form)) {
      const files = Array.isArray(value) ? value : [value];
      for (const f of files) {
        if (f instanceof File) {
          entries.push({ path, bytes: new Uint8Array(await f.arrayBuffer()) });
        }
      }
    }
    return deployResponse(c, deps.engine, deps.audit, cv, "folder", entries, c.get("user").id);
  });

  return app;
}

export { publicCanvas };

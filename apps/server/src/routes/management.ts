import { Buffer } from "node:buffer";
import { type Config, effectiveCapabilities, storedCapabilities } from "@canvas-drop/shared";
import type { Canvas, Manifest } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AuditLog } from "../audit/audit-log.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import { capabilityGlobals } from "../canvas/capability-guard.js";
import { rootEntry } from "../canvas/manifest.js";
import { hashPassword } from "../canvas/password.js";
import { generateUniqueSlug } from "../canvas/slug.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { DeployEngine } from "../deploy/engine.js";
import { DeployError } from "../deploy/errors.js";
import { type DeployEntry, fromPasteHtml, fromZip } from "../deploy/ingest.js";
import { requireSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
import { deployBodyLimit, deployResponse } from "./deploy-common.js";

export interface ManagementDeps {
  config: Config;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  audit: AuditLog;
  engine: DeployEngine;
  usage: UsageEventsRepository;
  files: FilesRepository;
}

const createSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  // Backend-group master switch chosen at create time (plan 006). Off by default.
  backendEnabled: z.boolean().optional(),
});

/** Capability patch (plan 006). All fields optional booleans; absent = unchanged. */
const capabilitiesSchema = z.object({
  backendEnabled: z.boolean().optional(),
  kv: z.boolean().optional(),
  files: z.boolean().optional(),
  ai: z.boolean().optional(),
  realtime: z.boolean().optional(),
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
    gallerySummary: cv.gallerySummary,
    // galleryTags is stored as JSON (Json | null); the API contract is string[] | null.
    galleryTags: cv.galleryTags as string[] | null,
    // Capability model (plan 006): the master switch, the raw stored feature flags,
    // and the effective state after ANDing operator globals (so the dashboard can
    // explain a feature that's off because the operator disabled it).
    backendEnabled: cv.backendEnabled,
    capabilities: storedCapabilities(cv),
    effective: effectiveCapabilities(cv, capabilityGlobals(config)),
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

  /** 409 body for deploy/rollback on a non-active (archived/disabled) canvas.
   *  Publishing to a canvas whose public URL 404s is incoherent — make the caller
   *  bring it back first. Settings/regenerate/delete stay allowed while archived. */
  const NOT_ACTIVE = {
    code: "NOT_ACTIVE",
    message: "Unarchive this canvas before deploying or changing its live version.",
  } as const;

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
      backendEnabled: body.data.backendEnabled,
    });
    deps.audit.recordAudit({ action: "canvas_create", actorId: user.id, targetId: cv.id });
    // apiKey is returned ONCE and never again.
    return c.json({ ...publicCanvas(deps.config, cv), apiKey }, 201);
  });

  /** Enrich a canvas list with each canvas's last-deploy summary in one batched
   *  version lookup (no N+1). Shared by the active list and the archived list. */
  async function withLastDeploy(list: Canvas[]) {
    const currentIds = list
      .map((cv) => cv.currentVersionId)
      .filter((id): id is string => id !== null);
    const byId = new Map((await deps.versions.findByIds(currentIds)).map((v) => [v.id, v]));
    return list.map((cv) => {
      const v = cv.currentVersionId ? byId.get(cv.currentVersionId) : undefined;
      return {
        ...publicCanvas(deps.config, cv),
        lastDeploy: v
          ? {
              version: v.number,
              createdAt: v.createdAt,
              fileCount: v.fileCount,
              totalBytes: v.totalBytes,
            }
          : null,
      };
    });
  }

  // List the caller's own ACTIVE canvases (excludes archived + deleted), each
  // enriched with its last-deploy summary.
  app.get("/", async (c) => {
    const canvases = await withLastDeploy(await deps.canvases.listByOwner(c.get("user").id));
    return c.json({ canvases });
  });

  // List the caller's own ARCHIVED canvases — the dedicated Archive view (§6.9.1).
  app.get("/archived", async (c) => {
    const canvases = await withLastDeploy(
      await deps.canvases.listArchivedByOwner(c.get("user").id),
    );
    return c.json({ canvases });
  });

  app.get("/:id", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    return c.json(publicCanvas(deps.config, cv));
  });

  // Owner usage stats (D24, plan 007 / M6): KV op count + file storage, derived
  // from usage_events + files. Owner-or-admin only (ownedCanvas), dashboard-session
  // gated — NOT the canvas runtime router.
  app.get("/:id/usage", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const counts = await deps.usage.countByType(cv.id, null);
    const [fileBytes, files] = await Promise.all([
      deps.files.totalBytes(cv.id),
      deps.files.list(cv.id),
    ]);
    return c.json({
      kvOps: counts.kv_op ?? 0,
      fileOps: counts.file_op ?? 0,
      fileCount: files.length,
      fileBytes,
    });
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

  app.patch("/:id/capabilities", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const body = capabilitiesSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const patch = body.data;
    if (Object.keys(patch).length === 0) return c.json(publicCanvas(deps.config, cv));
    const updated = await deps.canvases.updateCapabilities(cv.id, patch);
    deps.audit.recordAudit({
      action: "capabilities_update",
      actorId: c.get("user").id,
      targetId: cv.id,
      meta: { changed: Object.keys(patch) },
    });
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

  // Archive (owner-initiated, reversible) — takes the canvas offline (its public
  // URL 404s) and moves it to the Archive view. The guarded repo transition
  // returns false only for an already-deleted row, which ownedCanvas already 404s.
  app.post("/:id/archive", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    if (!(await deps.canvases.archive(cv.id))) return c.json({ error: "not_found" }, 404);
    deps.audit.recordAudit({
      action: "canvas_archive",
      actorId: c.get("user").id,
      targetId: cv.id,
    });
    return c.json(publicCanvas(deps.config, { ...cv, status: "archived" }));
  });

  // Unarchive — restore an archived canvas to active. A 409 on an invalid
  // transition (the canvas isn't archived) rather than silently flipping status.
  app.post("/:id/unarchive", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    if (!(await deps.canvases.unarchive(cv.id))) {
      return c.json({ code: "NOT_ARCHIVED", message: "canvas is not archived" }, 409);
    }
    deps.audit.recordAudit({
      action: "canvas_unarchive",
      actorId: c.get("user").id,
      targetId: cv.id,
    });
    return c.json(publicCanvas(deps.config, { ...cv, status: "active" }));
  });

  // Deploy history (§6.1.13). Session-authed sibling of the Bearer `/v1` versions
  // endpoint — owner/admin only, no existence leak. GET, so no same-origin guard.
  app.get("/:id/versions", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const versions = await deps.versions.listByCanvas(cv.id);
    return c.json({
      versions: versions.map((v) => ({
        number: v.number,
        source: v.source,
        status: v.status,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        current: v.id === cv.currentVersionId,
        // What this version serves at the canvas root (entry file / why not).
        entry: rootEntry((v.manifest ?? {}) as Manifest),
      })),
    });
  });

  // One-click rollback (§6.1.12). Mutation → same-origin guard. `findReadyByNumber`
  // is canvas-scoped, so a version number from another canvas cannot resolve.
  app.post("/:id/rollback", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    if (cv.status !== "active") return c.json(NOT_ACTIVE, 409);
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== "number") {
      return c.json({ code: "INVALID_PATH", message: "version (number) required" }, 400);
    }
    const target = await deps.versions.findReadyByNumber(cv.id, body.version);
    if (!target) {
      return c.json({ code: "INVALID_PATH", message: `no ready version ${body.version}` }, 404);
    }
    // Atomic guarded swap — false means a concurrent prune deleted the target
    // between selection and the swap; surface a clean retry rather than a
    // dangling pointer that would 404 the live canvas.
    if (!(await deps.canvases.setCurrentVersionIfReady(cv.id, target.id))) {
      return c.json(
        {
          code: "VERSION_UNAVAILABLE",
          message: "that version was just removed; refresh and try another",
        },
        409,
      );
    }
    deps.audit.recordAudit({
      action: "rollback",
      actorId: c.get("user").id,
      targetId: cv.id,
      meta: { version: body.version },
    });
    // Reflect the swap from known-good data (target.id) rather than re-reading —
    // avoids returning a stale snapshot if a refetch transiently fails.
    return c.json({
      ...publicCanvas(deps.config, { ...cv, currentVersionId: target.id }),
      version: body.version,
    });
  });

  // --- Deploy entry points (UI calls these; the engine + result shape is U18/U19) ---

  // Paste-HTML quick create: create a canvas, then deploy a single index.html.
  app.post("/paste", sameOrigin, deployBodyLimit, async (c) => {
    const body = z
      .object({
        html: z.string().min(1),
        title: z.string().max(200).optional(),
        backendEnabled: z.boolean().optional(),
      })
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
      backendEnabled: body.data.backendEnabled,
    });
    deps.audit.recordAudit({ action: "canvas_create", actorId: user.id, targetId: cv.id });
    // Deploy directly (typed result) rather than re-parsing a Response body. If
    // the deploy fails, soft-delete the just-created canvas so no orphan + its
    // once-shown key are left behind.
    try {
      const deploy = await deps.engine.deploy(cv, "paste", fromPasteHtml(body.data.html), user.id);
      deps.audit.recordAudit({
        action: "deploy",
        actorId: user.id,
        targetId: cv.id,
        meta: { source: "paste", version: deploy.version },
      });
      return c.json({ ...publicCanvas(deps.config, cv), apiKey, deploy }, 201);
    } catch (err) {
      await deps.canvases.setStatus(cv.id, "deleted").catch(() => {});
      if (err instanceof DeployError) {
        return c.json({ code: err.code, message: err.message, path: err.path }, 400);
      }
      throw err;
    }
  });

  app.post("/:id/deploy/zip", sameOrigin, deployBodyLimit, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    if (cv.status !== "active") return c.json(NOT_ACTIVE, 409);
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.byteLength === 0) return c.json({ code: "EMPTY_DEPLOY", message: "empty body" }, 400);
    return deployResponse(c, deps.engine, deps.audit, cv, "zip", fromZip(buf), c.get("user").id);
  });

  app.post("/:id/deploy/folder", sameOrigin, deployBodyLimit, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    if (cv.status !== "active") return c.json(NOT_ACTIVE, 409);
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

  // Paste a new index.html as the next version of an EXISTING canvas (the
  // same-origin sibling of /paste, which is create-only). Mirrors zip/folder.
  app.post("/:id/deploy/paste", sameOrigin, deployBodyLimit, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    if (cv.status !== "active") return c.json(NOT_ACTIVE, 409);
    const body = z
      .object({ html: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    return deployResponse(
      c,
      deps.engine,
      deps.audit,
      cv,
      "paste",
      fromPasteHtml(body.data.html),
      c.get("user").id,
    );
  });

  return app;
}

export { publicCanvas };

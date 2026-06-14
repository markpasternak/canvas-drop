import { Buffer } from "node:buffer";
import {
  type CapabilityGlobals,
  type Config,
  effectiveCapabilities,
  storedCapabilities,
} from "@canvas-drop/shared";
import type { Canvas, CanvasStatus, Manifest } from "@canvas-drop/shared/db";
import { publicationState } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AuditLog } from "../audit/audit-log.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import type { CloneService } from "../canvas/clone-service.js";
import { rootEntry } from "../canvas/manifest.js";
import { hashPassword } from "../canvas/password.js";
import { generateUniqueSlug } from "../canvas/slug.js";
import { canvasUrl } from "../canvas/url.js";
import type { AiUsageRepository } from "../db/repositories/ai-usage.js";
import type { CanvasesRepository, CanvasSettingsPatch } from "../db/repositories/canvases.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { DeployEngine } from "../deploy/engine.js";
import { DeployError } from "../deploy/errors.js";
import { type DeployEntry, fromPasteHtml, fromZip } from "../deploy/ingest.js";
import { requireSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { deployBodyLimit, deployResponse } from "./deploy-common.js";

export interface ManagementDeps {
  config: Config;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  clone: CloneService;
  audit: AuditLog;
  engine: DeployEngine;
  usage: UsageEventsRepository;
  files: FilesRepository;
  aiUsage: AiUsageRepository;
  /**
   * Realtime hub for revoke-drops-socket (D-RT-6). Optional — when present, access-
   * changing mutations (settings, capabilities, disable, delete, slug regen) drop
   * live sockets that lost access; a newly-set password drops gated non-owners.
   */
  hub?: RealtimeHub;
  /**
   * Effective operator-global resolvers (admin DB override ?? env). Optional —
   * omitted in unit tests, which fall back to the boot `config` values. Used so
   * the `effective` capability state the dashboard reads reflects a runtime-set
   * AI key / realtime switch.
   */
  aiEnabled?: () => Promise<boolean>;
  realtimeEnabled?: () => Promise<boolean>;
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
  galleryTemplatable: z.boolean().optional(),
  gallerySummary: z.string().max(500).nullable().optional(),
  galleryTags: z.array(z.string()).optional(),
});

/**
 * OWNER/ADMIN canvas view (never leaks `api_key_hash` / `password_hash`). Every
 * caller of this projection is gated by `ownedCanvas` (owner/admin) or
 * `requireAdmin`, so it carries the owner-facing `disabledReason` (§6.10.2 — "owner
 * sees why"). It is NOT a public/shared projection: any future non-owner-facing
 * view (gallery, shared link) must be a SEPARATE function that omits `disabledReason`
 * and other owner-only fields. Misnamed "public" for historical reasons.
 */
function publicCanvas(config: Config, cv: Canvas, globals: CapabilityGlobals) {
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
    galleryTemplatable: cv.galleryTemplatable,
    gallerySummary: cv.gallerySummary,
    // galleryTags is stored as JSON (Json | null); the API contract is string[] | null.
    galleryTags: cv.galleryTags as string[] | null,
    // Lineage (plan 002): the canvas this one was cloned from, for "Cloned from …".
    clonedFromCanvasId: cv.clonedFromCanvasId,
    // Capability model (plan 006): the master switch, the raw stored feature flags,
    // and the effective state after ANDing operator globals (so the dashboard can
    // explain a feature that's off because the operator disabled it).
    backendEnabled: cv.backendEnabled,
    capabilities: storedCapabilities(cv),
    // Effective state ANDs in the operator globals — resolved per request so an
    // admin's DB override of the AI key / realtime switch is reflected here too.
    effective: effectiveCapabilities(cv, globals),
    status: cv.status,
    // Single derived lifecycle (Draft/Published/Archived/Disabled) the dashboard
    // renders as the Publication chip — one authoritative value, never stored.
    publicationState: publicationState(cv.status as CanvasStatus, cv.currentVersionId !== null),
    // Admin takedown reason (§6.10.2, M7). Owner/admin-only — see the doc above.
    disabledReason: cv.disabledReason,
    currentVersionId: cv.currentVersionId,
    createdAt: cv.createdAt,
    updatedAt: cv.updatedAt,
  };
}

const CANVASES_PAGE_SIZE = 24;
const CANVASES_MAX_LIMIT = 60;

/** Coerce an optional query flag ("1"/"true" → true; absent/anything else → false). */
const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

/**
 * Your-canvases browse query (plan 005). Mirrors the gallery schema: invalid or
 * absent values clamp to defaults rather than 400ing, so a junk param still
 * renders the owner's list. `undeployed` is the URL param for the never-deployed
 * filter (maps to the repo's `neverDeployed`); `sort` falls back to `updated`.
 */
const ownerListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  shared: boolFlag,
  protected: boolFlag,
  listed: boolFlag,
  template: boolFlag,
  undeployed: boolFlag,
  // Lifecycle scope: the active set (default) or the archived set (Your-canvases
  // Active/Archived toggle). A junk value falls back to active.
  scope: z.enum(["active", "archived"]).catch("active"),
  sort: z.enum(["updated", "created", "title"]).catch("updated"),
  limit: z.coerce.number().int().catch(CANVASES_PAGE_SIZE),
  offset: z.coerce.number().int().catch(0),
});

/**
 * Canvas lifecycle management API (§11.3), mounted at `/api/canvases`. Owner (or
 * admin) authenticated via the foundation gateway; same-origin enforced on
 * mutating routes. Deploy routes are added by U19.
 */
export function managementRoutes(deps: ManagementDeps) {
  const app = new Hono<AppEnv>();
  const sameOrigin = requireSameOrigin(deps.config);

  /** Resolve the operator globals for THIS request (admin DB override ?? env). */
  async function resolveGlobals(): Promise<CapabilityGlobals> {
    return {
      realtimeEnabled: deps.realtimeEnabled
        ? await deps.realtimeEnabled()
        : deps.config.realtimeEnabled,
      aiEnabled: deps.aiEnabled ? await deps.aiEnabled() : !!deps.config.ai.apiKey,
    };
  }
  /** Serialize one canvas with the per-request effective globals. */
  async function canvasView(cv: Canvas) {
    return publicCanvas(deps.config, cv, await resolveGlobals());
  }

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
    return c.json({ ...(await canvasView(cv)), apiKey }, 201);
  });

  // Clone → a new canvas owned by the caller, seeded from an existing one (plan 002).
  // An owner may clone any ACTIVE canvas they own; a non-owner only a gallery-listed
  // + templatable one. Eligibility is re-derived server-side from the row (never the
  // client); a non-eligible source 404s opaquely so its existence isn't revealed
  // (§12.2). The clone gets its OWN fresh deploy key (the source's is never copied),
  // but unlike create we do NOT return the plaintext here — a clone's key is revealed
  // on demand via Settings → Regenerate key, so an unused secret never transits the
  // wire (plan 002 decision).
  app.post("/:id/clone", sameOrigin, async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    const source = await deps.canvases.findById(id);
    if (!source || source.status === "deleted") return c.json({ error: "not_found" }, 404);

    const eligible =
      source.ownerId === user.id
        ? source.status === "active"
        : (await deps.canvases.findCloneableTemplate(id, Date.now())) !== null;
    if (!eligible) return c.json({ error: "not_found" }, 404);

    const { canvas } = await deps.clone.clone(source, user.id);
    deps.audit.recordAudit({
      action: "canvas_clone",
      actorId: user.id,
      targetId: canvas.id,
      meta: { from: source.id },
    });
    return c.json(await canvasView(canvas), 201);
  });

  /** Enrich a canvas list with each canvas's last-deploy summary in one batched
   *  version lookup (no N+1). Shared by the active list and the archived list. */
  async function withLastDeploy(list: Canvas[]) {
    const currentIds = list
      .map((cv) => cv.currentVersionId)
      .filter((id): id is string => id !== null);
    const byId = new Map((await deps.versions.findByIds(currentIds)).map((v) => [v.id, v]));
    // Globals are request-global (not per-canvas) — resolve once, reuse for the row.
    const globals = await resolveGlobals();
    return list.map((cv) => {
      const v = cv.currentVersionId ? byId.get(cv.currentVersionId) : undefined;
      return {
        ...publicCanvas(deps.config, cv, globals),
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

  // List the caller's own canvases — active by default, or the archived set when
  // `scope=archived` (the Your-canvases Active/Archived toggle, replacing the old
  // standalone /archived view). Server-side filter/search/sort + offset pagination
  // (plan 005): a malformed query falls back to all-defaults so the list never 400s,
  // and every param ANDs onto the owner-scope base in the repo — it can only shrink
  // the caller's own set.
  app.get("/", async (c) => {
    const parsed = ownerListQuerySchema.safeParse(c.req.query());
    const data = parsed.success
      ? parsed.data
      : {
          q: undefined,
          shared: false,
          protected: false,
          listed: false,
          template: false,
          undeployed: false,
          scope: "active" as const,
          sort: "updated" as const,
          limit: CANVASES_PAGE_SIZE,
          offset: 0,
        };
    const limit = Math.min(Math.max(data.limit, 1), CANVASES_MAX_LIMIT);
    const offset = Math.max(data.offset, 0);

    const userId = c.get("user").id;
    // The filtered page and the (filter-independent) inventory summary have no data
    // dependency — run them concurrently rather than serially.
    const [{ items, total }, summary] = await Promise.all([
      deps.canvases.listByOwnerFiltered({
        ownerId: userId,
        q: data.q,
        shared: data.shared,
        protected: data.protected,
        listed: data.listed,
        template: data.template,
        neverDeployed: data.undeployed,
        archived: data.scope === "archived",
        sort: data.sort,
        limit,
        offset,
      }),
      deps.canvases.ownerSummary(userId),
    ]);
    const canvases = await withLastDeploy(items);
    return c.json({ canvases, total, limit, offset, summary });
  });

  app.get("/:id", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    return c.json(await canvasView(cv));
  });

  // Owner usage stats (D24): KV op count + file storage (M6) + AI tokens/cost and
  // realtime connect count (M9), derived from usage_events + files + ai_usage.
  // Owner-or-admin only (ownedCanvas), dashboard-session gated — NOT the runtime router.
  // Realtime is ephemeral, so "peak concurrent connections" isn't derivable; we
  // surface the connect count (rt_connect events) instead.
  app.get("/:id/usage", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    // View stats (D24) exist for EVERY canvas regardless of backend capability;
    // primitive op counts only for backend-on canvases. The 30-day sparkline window
    // sits well inside the 90-day usage_events retention, so the series never truncates.
    const now = Date.now();
    const sparklineSince = now - 30 * 24 * 60 * 60 * 1000;
    const [counts, fileBytes, fileCount, ai, views, viewsByDay] = await Promise.all([
      deps.usage.countByType(cv.id, null),
      deps.files.totalBytes(cv.id),
      deps.files.countFiles(cv.id),
      deps.aiUsage.canvasTotals(cv.id),
      deps.usage.viewStats(cv.id),
      deps.usage.viewsByDay(cv.id, sparklineSince, now),
    ]);
    return c.json({
      totalViews: views.totalViews,
      uniqueViewers: views.uniqueViewers,
      lastViewedAt: views.lastViewedAt,
      viewsByDay,
      kvOps: counts.kv_op ?? 0,
      fileOps: counts.file_op ?? 0,
      fileCount,
      fileBytes,
      aiCalls: ai.calls,
      aiTokens: ai.inputTokens + ai.outputTokens,
      aiCostUsd: ai.costUsd,
      realtimeConnects: counts.rt_connect ?? 0,
    });
  });

  app.patch("/:id/settings", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const body = settingsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const p = body.data;
    const { password, ...rest } = p;

    // Listability rules (plan 002 R9/R10/R11). A canvas is listable only when it is
    // shared AND published AND will be unprotected after this patch; a password set
    // (or un-share) always un-lists. "Templatable" can only be on when the canvas
    // ends up listed. These mirror the galleryVisibilityFilters read predicate, so
    // the at-rest row can't reach a listed-but-invisible state (templatable ⊆ listed
    // ⊆ shared/published/unprotected).
    const willBeProtected = password === undefined ? cv.passwordHash !== null : password !== null;
    const willBeShared = rest.shared === undefined ? cv.shared : rest.shared;
    const isPublished = cv.currentVersionId !== null;
    if (rest.galleryListed === true) {
      if (!willBeShared) {
        return c.json(
          { code: "NOT_SHARED", message: "Share this canvas before listing it in the gallery." },
          409,
        );
      }
      if (!isPublished) {
        return c.json(
          {
            code: "NOT_PUBLISHED",
            message: "Publish this canvas before listing it in the gallery.",
          },
          409,
        );
      }
      if (willBeProtected) {
        return c.json(
          {
            code: "PASSWORD_PROTECTED",
            message: "Remove the password before listing this canvas in the gallery.",
          },
          409,
        );
      }
    }
    // Setting a password OR un-sharing forces the canvas un-listed, so it can never
    // end up listed-but-invisible.
    const finalListed =
      typeof password === "string" || !willBeShared
        ? false
        : (rest.galleryListed ?? cv.galleryListed);
    if (rest.galleryTemplatable === true && !finalListed) {
      return c.json(
        {
          code: "NOT_LISTED",
          message: "List this canvas in the gallery before allowing templates.",
        },
        409,
      );
    }

    // Build the persisted patch — the server enforces the listability invariant
    // regardless of what the client sent. (updateSettings also clears templatable
    // whenever galleryListed is set false, keeping templatable ⊆ listed.)
    const patch: CanvasSettingsPatch = { ...rest };
    // Un-share un-lists, but KEEPS the gallery summary/tags so re-sharing later
    // restores them without the owner re-typing (R11).
    if (rest.shared === false) {
      patch.galleryListed = false;
      patch.galleryTemplatable = false;
    }
    // A newly-set password un-lists AND clears the gallery metadata — a password is a
    // deliberate "make private" signal, not a temporary toggle (R10).
    if (typeof password === "string") {
      patch.galleryListed = false;
      patch.galleryTemplatable = false;
      patch.gallerySummary = null;
      patch.galleryTags = null;
    }

    let updated = cv;
    if (Object.keys(patch).length > 0) {
      updated = await deps.canvases.updateSettings(cv.id, patch);
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
    // Revoke-drops-socket (D-RT-6): un-share / new-expiry drop sockets that lost
    // access; a newly-set password drops gated non-owners (no re-verified grant).
    if (deps.hub) {
      await deps.hub.revalidateCanvas(cv.id).catch(() => {});
      if (typeof password === "string") await deps.hub.dropGatedNonOwners(cv.id).catch(() => {});
    }
    return c.json(await canvasView(updated));
  });

  app.patch("/:id/capabilities", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const body = capabilitiesSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const patch = body.data;
    if (Object.keys(patch).length === 0) return c.json(await canvasView(cv));
    const updated = await deps.canvases.updateCapabilities(cv.id, patch);
    deps.audit.recordAudit({
      action: "capabilities_update",
      actorId: c.get("user").id,
      targetId: cv.id,
      meta: { changed: Object.keys(patch) },
    });
    // Turning realtime (or the backend group) off must drop live sockets — the
    // heartbeat would too, but this makes it instant (D-RT-6).
    if (deps.hub) await deps.hub.revalidateCanvas(cv.id).catch(() => {});
    return c.json(await canvasView(updated));
  });

  app.post("/:id/regenerate-slug", sameOrigin, async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const slug = await generateUniqueSlug(
      async (s) => (await deps.canvases.findBySlug(s)) !== null,
    );
    const updated = await deps.canvases.regenerateSlug(cv.id, slug);
    deps.audit.recordAudit({ action: "slug_regen", actorId: c.get("user").id, targetId: cv.id });
    // Old slug URLs are invalidated — drop all live sockets so clients reconnect
    // under the new slug (D-RT-6 / §12.0 #5).
    deps.hub?.dropCanvas(cv.id);
    return c.json(await canvasView(updated));
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
    // An OWNER cannot delete a canvas an admin has taken down (§12.0 #5): deleting
    // then having an admin restore it would launder the takedown into an active
    // canvas. The admin must `enable` it first, or an admin can delete it directly.
    if (cv.status === "disabled" && !c.get("user").isAdmin) {
      return c.json(
        { code: "DISABLED", message: "this canvas was disabled by an administrator" },
        409,
      );
    }
    await deps.canvases.setStatus(cv.id, "deleted");
    deps.audit.recordAudit({ action: "canvas_delete", actorId: c.get("user").id, targetId: cv.id });
    // Deleted → everyone (incl. owner) loses access; drop their live sockets.
    if (deps.hub) await deps.hub.revalidateCanvas(cv.id).catch(() => {});
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
    // Archived → offline for everyone; drop live sockets (D-RT-6).
    if (deps.hub) await deps.hub.revalidateCanvas(cv.id).catch(() => {});
    return c.json(await canvasView({ ...cv, status: "archived" }));
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
    return c.json(await canvasView({ ...cv, status: "active" }));
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
      ...(await canvasView({ ...cv, currentVersionId: target.id })),
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
      return c.json({ ...(await canvasView(cv)), apiKey, deploy }, 201);
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

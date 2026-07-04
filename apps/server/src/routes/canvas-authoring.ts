import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AdminSettingsService } from "../admin/settings-service.js";
import { dayStartUtc } from "../ai/quota.js";
import type { AuditLog } from "../audit/audit-log.js";
import { checkAuthoringQuota } from "../authoring/quota.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import { requireCapability } from "../canvas/capability-guard.js";
import { hashPassword } from "../canvas/password.js";
import { resolveCreateSlug } from "../canvas/slug.js";
import { canvasUrl } from "../canvas/url.js";
import type { AuthoringUsageRepository } from "../db/repositories/authoring-usage.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { DeployEngine } from "../deploy/engine.js";
import { fromZip } from "../deploy/ingest.js";
import { requireCanvas } from "../http/canvas-api-isolation.js";
import type { AppEnv } from "../http/types.js";
import { resolveHomeOrg } from "../tenancy/home-org.js";

/** The slice of the settings service the authoring route reads (DB-effective config). */
export type AuthoringSettings = Pick<
  AdminSettingsService,
  "authoringEnabled" | "effectiveAuthoringPolicy"
>;

/** Max publish bundle (the zip) buffered into memory before unzip. Generous for a
 *  static site; the deploy engine still enforces per-file + per-canvas byte limits on
 *  the UNZIPPED content, so this only bounds the transport buffer. */
export const AUTHORING_MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

export interface CanvasAuthoringDeps {
  config: Config;
  canvases: CanvasesRepository;
  engine: DeployEngine;
  authoringUsage: AuthoringUsageRepository;
  audit: AuditLog;
  /** Effective authoring switch + policy (DB override ?? env). Omitted in unit tests → config. */
  settings?: AuthoringSettings;
}

/** Publish metadata (the JSON `metadata` part alongside the `bundle` file part). */
const publishMeta = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  access: z.enum(["private", "specific_people", "public_link", "password"]).optional(),
  password: z.string().min(1).max(200).optional(),
  expiresAt: z.number().int().positive().optional(),
});

/**
 * Authoring primitive route (plan 2026-07-04), mounted at `/v1/c/:slug/authoring`.
 * Mirrors `canvas-ai.ts`: behind `requireCapability("authoring")` (→ 403
 * CAPABILITY_DISABLED when backend off, per-canvas `cap_authoring` off, or the
 * operator instance switch off). Lets a backend-enabled canvas's signed-in members
 * create → deploy → configure a NEW canvas AS THEMSELVES.
 *
 * The pipeline already refuses static-only (anonymous / public-link) requests before
 * a primitive runs, so the only extra identity check here is rejecting a legacy
 * GUEST principal — creation needs a real org member (NOT_AUTHENTICATED).
 *
 *  - `POST /`        publish: create + deploy the zip bundle + apply share settings.
 *  - `GET /`         list the viewer's own authored canvases.
 *  - `DELETE /:id`   revoke (soft-delete) one of the viewer's authored canvases.
 */
export function canvasAuthoringRoutes(deps: CanvasAuthoringDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const settings = deps.settings;

  app.use(
    "*",
    requireCapability(
      "authoring",
      deps.config,
      settings ? { authoringEnabled: () => settings.authoringEnabled() } : undefined,
    ),
  );

  /** Effective policy: DB override ?? env (settings), else the boot config. */
  async function policy() {
    if (settings) return settings.effectiveAuthoringPolicy();
    const a = deps.config.authoring;
    return {
      userDailyMax: a.userDailyMax,
      userTotalMax: a.userTotalMax,
      allowedRungs: a.allowedRungs,
      maxExpiryDays: a.maxExpiryDays,
      requireExpiry: a.requireExpiry,
    };
  }

  /** The viewer must be a real org member — a legacy guest principal is rejected.
   *  (Anonymous / public-link never reach here: refused static-only upstream.) */
  function requireMember(
    c: import("hono").Context<AppEnv>,
  ): { id: string; isAdmin: boolean } | null {
    const user = c.get("user");
    if (!user || c.get("principal")?.kind === "guest") return null;
    return { id: user.id, isAdmin: !!user.isAdmin };
  }

  const bundleLimit = bodyLimit({
    maxSize: AUTHORING_MAX_BUNDLE_BYTES,
    onError: (c) => c.json({ code: "INVALID_BODY", message: "bundle too large" }, 413),
  });

  app.post("/", bundleLimit, async (c) => {
    const viewer = requireMember(c);
    if (!viewer) return c.json({ code: "NOT_AUTHENTICATED" }, 401);
    const source = requireCanvas(c); // canvas A (the page the viewer is on)

    // Parse the multipart body: a JSON `metadata` part + a `bundle` zip file part.
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ code: "INVALID_BODY", message: "expected multipart/form-data" }, 400);
    }
    const metaRaw = form.get("metadata");
    const bundle = form.get("bundle");
    if (typeof metaRaw !== "string" || !(bundle instanceof File)) {
      return c.json({ code: "INVALID_BODY", message: "metadata + bundle required" }, 400);
    }
    let metaJson: unknown;
    try {
      metaJson = JSON.parse(metaRaw);
    } catch {
      return c.json({ code: "INVALID_BODY", message: "metadata is not valid JSON" }, 400);
    }
    const parsed = publishMeta.safeParse(metaJson);
    if (!parsed.success) return c.json({ code: "INVALID_BODY" }, 400);
    const meta = parsed.data;
    if (bundle.size === 0) return c.json({ code: "INVALID_BODY", message: "empty bundle" }, 400);

    // Validate access rung + password + expiry against the operator policy.
    const pol = await policy();
    const requestedAccess = meta.access ?? "private";
    const rung = requestedAccess === "password" ? "public_link" : requestedAccess;
    if (!pol.allowedRungs.includes(rung)) {
      return c.json({ code: "INVALID_BODY", message: `access rung "${rung}" is not allowed` }, 400);
    }
    if (requestedAccess === "password" && !meta.password) {
      return c.json(
        { code: "INVALID_BODY", message: "password required for password access" },
        400,
      );
    }
    const shareable = rung !== "private";
    const now = Date.now();
    if (pol.requireExpiry && shareable && meta.expiresAt === undefined) {
      return c.json({ code: "INVALID_BODY", message: "an expiry is required" }, 400);
    }
    if (meta.expiresAt !== undefined) {
      if (meta.expiresAt <= now) {
        return c.json({ code: "INVALID_BODY", message: "expiresAt is in the past" }, 400);
      }
      if (pol.maxExpiryDays > 0 && meta.expiresAt > now + pol.maxExpiryDays * 86_400_000) {
        return c.json({ code: "INVALID_BODY", message: "expiresAt exceeds the maximum" }, 400);
      }
    }

    // Quota: per-viewer daily + all-time total (checked before any row is created).
    const [dailyCount, totalCount] = await Promise.all([
      deps.authoringUsage.countByActorSince(viewer.id, dayStartUtc(now)),
      deps.authoringUsage.countByActor(viewer.id),
    ]);
    const quota = checkAuthoringQuota(dailyCount, totalCount, {
      dailyMax: pol.userDailyMax,
      totalMax: pol.userTotalMax,
    });
    if (!quota.ok) return c.json({ code: "QUOTA_EXCEEDED", scope: quota.scope }, 429);

    // Resolve a slug (readable-random unless a valid custom one is supplied).
    const resolved = await resolveCreateSlug(meta.slug, (s) => deps.canvases.slugTaken(s));
    if ("error" in resolved) return c.json({ code: "INVALID_BODY", reason: resolved.error }, 400);
    const home = resolveHomeOrg(undefined, c.get("orgIds") ?? new Set<string>());
    if ("error" in home) return c.json({ code: "INVALID_BODY", reason: home.error }, 400);

    // Create canvas B under the VIEWER's principal (real per-user ownership).
    const apiKey = generateApiKey();
    let canvasB: Canvas;
    try {
      canvasB = await deps.canvases.create({
        ownerId: viewer.id,
        slug: resolved.slug,
        slugCustom: resolved.custom,
        apiKeyHash: hashApiKey(apiKey),
        title: meta.title,
        orgId: home.orgId,
      });
    } catch (err) {
      c.get("log")?.error({ err }, "authoring: create failed");
      return c.json({ code: "PUBLISH_FAILED", message: "could not create the canvas" }, 502);
    }

    // Deploy the bundle. On failure canvas B exists but is empty — return its id so the
    // consumer can retry the deploy or revoke it (Q3: return-id, no auto-revoke).
    try {
      const buffer = Buffer.from(await bundle.arrayBuffer());
      await deps.engine.deploy(canvasB, "api", fromZip(buffer), viewer.id);
    } catch (err) {
      c.get("log")?.error({ err, id: canvasB.id }, "authoring: deploy failed");
      return c.json({ code: "PUBLISH_FAILED", id: canvasB.id, message: "deploy failed" }, 502);
    }

    // Apply share settings. A failure here also returns PUBLISH_FAILED with the id
    // (the canvas exists + is deployed; only the share config is partial).
    try {
      await deps.canvases.updateSettings(canvasB.id, {
        access: rung,
        tags: meta.tags,
        sharedExpiresAt: meta.expiresAt,
      });
      if (requestedAccess === "password" && meta.password) {
        await deps.canvases.setPassword(canvasB.id, await hashPassword(meta.password));
      }
    } catch (err) {
      c.get("log")?.error({ err, id: canvasB.id }, "authoring: configure failed");
      return c.json({ code: "PUBLISH_FAILED", id: canvasB.id, message: "configure failed" }, 502);
    }

    // Meter (awaited so the quota window reflects it) + audit, only on full success.
    await deps.authoringUsage.record({
      actorId: viewer.id,
      sourceCanvasId: source.id,
      authoredCanvasId: canvasB.id,
    });
    deps.audit.recordAudit({
      action: "canvas_authored",
      actorId: viewer.id,
      targetId: canvasB.id,
      meta: { sourceCanvasId: source.id },
    });

    return c.json({ id: canvasB.id, url: canvasUrl(deps.config, canvasB.slug) });
  });

  app.get("/", async (c) => {
    const viewer = requireMember(c);
    if (!viewer) return c.json({ code: "NOT_AUTHENTICATED" }, 401);
    const ids = await deps.authoringUsage.authoredIdsByActor(viewer.id);
    const rows = await Promise.all(ids.map((id) => deps.canvases.findById(id)));
    const canvases = rows
      .filter((cv): cv is Canvas => !!cv && cv.status !== "deleted" && cv.ownerId === viewer.id)
      .map((cv) => ({
        id: cv.id,
        url: canvasUrl(deps.config, cv.slug),
        title: cv.title,
        tags: cv.tags ?? [],
        expiresAt: cv.sharedExpiresAt ?? null,
      }));
    return c.json({ canvases });
  });

  app.delete("/:id", async (c) => {
    const viewer = requireMember(c);
    if (!viewer) return c.json({ code: "NOT_AUTHENTICATED" }, 401);
    const id = c.req.param("id");
    const cv = await deps.canvases.findById(id);
    // Owner or admin only; a non-owned / missing id reads as not-found (no existence leak).
    if (!cv || cv.status === "deleted" || (cv.ownerId !== viewer.id && !viewer.isAdmin)) {
      return c.json({ code: "NOT_FOUND" }, 404);
    }
    await deps.canvases.setStatus(cv.id, "deleted");
    deps.audit.recordAudit({
      action: "canvas_authored_revoke",
      actorId: viewer.id,
      targetId: cv.id,
    });
    return c.body(null, 204);
  });

  return app;
}

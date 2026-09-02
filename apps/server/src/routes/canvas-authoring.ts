import { type Config, shareStatus } from "@canvas-drop/shared";
import type { AccessRung, Canvas, Json } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AdminSettingsService } from "../admin/settings-service.js";
import { dayStartUtc } from "../ai/quota.js";
import type { AuditLog } from "../audit/audit-log.js";
import { checkAuthoringQuota } from "../authoring/quota.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import { memberPrincipal } from "../canvas/authorization.js";
import { requireCapability } from "../canvas/capability-guard.js";
import { disabledError } from "../canvas/owner-guard.js";
import { hashPasswordMutation } from "../canvas/password.js";
import { type RoleGrant, resolveManagementGrant } from "../canvas/role.js";
import { resolveSettingsUpdate } from "../canvas/settings-update.js";
import { resolveCreateSlug } from "../canvas/slug.js";
import { canvasUrl } from "../canvas/url.js";
import type { AuthoringUsageRepository } from "../db/repositories/authoring-usage.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import { isUniqueViolation, SLUG_UNIQUE } from "../db/unique-violation.js";
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

/** Max serialized `metadata` blob (authoring v2). Bounds the free-form JSON stored on
 *  the share row so a consumer can't stuff megabytes of state into a canvas. */
export const AUTHORING_MAX_METADATA_BYTES = 16 * 1024;

export interface CanvasAuthoringDeps {
  config: Config;
  canvases: CanvasesRepository;
  engine: DeployEngine;
  authoringUsage: AuthoringUsageRepository;
  audit: AuditLog;
  /** Effective authoring switch + policy (DB override ?? env). Omitted in unit tests → config. */
  settings?: AuthoringSettings;
  /** Effective instance-wide public-link gate (same switch the dashboard/MCP honor).
   *  Omitted → defaults on. A `public_link` publish is refused when this is off, so
   *  authoring can't bypass the admin's instance switch. */
  publicLinksEnabled?: () => Promise<boolean>;
  /** Canonical team-grant cleanup + management-only audience projection. */
  teams?: Pick<TeamsRepository, "setCanvasTeams" | "listCanvasTeamGrants" | "findByIds">;
}

const accessEnum = z.enum(["private", "specific_people", "whole_org", "public_link", "password"]);
const metadataSchema = z.record(z.string(), z.unknown());

/** Publish metadata (the JSON `metadata` part alongside the `bundle` file part). */
const publishMeta = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  access: accessEnum.optional(),
  password: z.string().min(1).max(200).optional(),
  expiresAt: z.number().int().positive().optional(),
  metadata: metadataSchema.optional(),
});

/** Update metadata (authoring v2). Every field optional; `password`/`expiresAt` accept
 *  `null` to explicitly clear. Omitted fields leave the share unchanged. */
const updateMeta = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  access: accessEnum.optional(),
  password: z.string().min(1).max(200).nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  /** Compare-and-swap token returned as AuthoredCanvas.updatedAt. */
  expectedUpdatedAt: z.number().int().positive().optional(),
  metadata: metadataSchema.optional(),
});

type ValidationError = { code: string; message?: string; status: 400 | 403 };

/**
 * Authoring primitive route (plan 2026-07-04, extended to managed shares 2026-07-05),
 * mounted at `/v1/c/:slug/authoring`. Behind `requireCapability("authoring")`. Lets a
 * backend-enabled canvas's signed-in members create → deploy → configure a NEW canvas
 * AS THEMSELVES, then manage it as a durable **share**.
 *
 * The runtime pipeline already refuses static-only (anonymous / public-link) requests
 * before a primitive runs, so the only extra identity check is rejecting a legacy GUEST
 * principal — creation needs a real org member (NOT_AUTHENTICATED).
 *
 *  - `POST /`        publish: create + deploy the zip bundle + apply share settings.
 *  - `PUT /:id`      update in place: new version (stable URL) and/or settings/metadata.
 *  - `GET /`         list the viewer's authored shares (management projection + filter).
 *  - `DELETE /:id`   revoke: URL made unreadable, record stays listed as "revoked".
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
  ): { id: string; isAdmin: boolean; canPublishPublic: boolean } | null {
    const user = c.get("user");
    if (!user || c.get("principal")?.kind === "guest") return null;
    return { id: user.id, isAdmin: !!user.isAdmin, canPublishPublic: !!user.canPublishPublic };
  }

  /** The role resolver's deps (editor-roles plan, KTD1). */
  const roleDeps = { canvases: deps.canvases, tenancyActive: !!deps.config.org.name };

  /**
   * The management gate for an authored share: OWNER OR EDITOR through the shared
   * resolver (editor-roles plan, KTD1), with the pre-existing ADMIN allowance retained
   * unchanged (KTD12 — the §12.0 #3 conflict is recorded, not resolved, this round).
   * A non-managed / missing / deleted id reads as null → not-found (no existence leak).
   */
  async function managedShare(
    c: import("hono").Context<AppEnv>,
    id: string,
    viewer: { id: string; isAdmin: boolean },
  ): Promise<{ canvas: Canvas; role: "owner" | "editor" | "admin" } | null> {
    const cv = await deps.canvases.findById(id);
    if (!cv || cv.status === "deleted") return null;
    const grant = await resolveManagementGrant(
      cv,
      memberPrincipal(viewer, c.get("orgIds") ?? new Set<string>()),
      roleDeps,
    );
    if (grant) return { canvas: grant.canvas, role: grant.role };
    // The pre-existing admin allowance (KTD12), retained unchanged this round.
    return viewer.isAdmin ? { canvas: cv, role: "admin" } : null;
  }

  /** The management projection (authoring v2). Assembled ONLY here (the authenticated
   *  management API) — the public canvas-serve path never reads `metadata`, so a reader
   *  structurally cannot receive author/management data (reader isolation). */
  async function toAuthoredCanvas(cv: Canvas, viewerRole: "owner" | "editor" | "admin") {
    const now = Date.now();
    const metadata = (cv.metadata ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    // The people-and-teams list applies at EVERY rung (restricted access model), so the
    // audience summary is rung-agnostic: the viewer-role people and teams on the list
    // (editors manage the share rather than merely view it, so they are not the audience).
    const viewers = (await deps.canvases.listAllowlist(cv.id)).filter(
      (entry) => entry.role === "viewer",
    );
    let teamCount = 0;
    let teamNames: string[] = [];
    if (deps.teams) {
      const grants = (await deps.teams.listCanvasTeamGrants(cv.id)).filter(
        (grant) => grant.role === "viewer",
      );
      teamCount = grants.length;
      teamNames = (await deps.teams.findByIds(grants.map((g) => g.teamId))).map((t) => t.name);
    }
    const audienceSummary: { count: number | null; names: string[] } = {
      count: viewers.length + teamCount,
      names: teamNames,
    };
    return {
      id: cv.id,
      url: canvasUrl(deps.config, cv.slug),
      title: cv.title,
      tags: (cv.tags as string[] | null) ?? [],
      access: cv.access,
      hasPassword: cv.passwordHash !== null,
      status: shareStatus(cv.access, cv.sharedExpiresAt ?? null, cv.revokedAt ?? null, now),
      createdAt: cv.createdAt,
      updatedAt: cv.updatedAt,
      expiresAt: cv.sharedExpiresAt ?? null,
      discoverability: cv.discoverability,
      galleryListed: cv.galleryListed,
      galleryTemplatable: cv.galleryTemplatable,
      revokedAt: cv.revokedAt ?? null,
      viewerRole,
      audienceSummary,
      createdBy: cv.ownerId,
      // The bundle-change signal: `currentVersionId` advances on every deploy;
      // `bundleUpdatedAt` is the row's last-write stamp (deploy or settings).
      version: cv.currentVersionId,
      bundleUpdatedAt: cv.updatedAt,
      sourceApp: str(metadata.sourceApp),
      sourceKind: str(metadata.sourceKind),
      metadata,
    };
  }

  /**
   * Shared access/password/expiry gate for publish + update, validated against the
   * share's resolved END STATE (not just the fields this request changed) — so an update
   * that widens exposure (clearing a password, dropping an expiry) faces the same operator
   * gates a publish would. Each caller resolves the end state and passes it in.
   *
   * Enforces, in order: the operator allowed-rung set (only when access is explicitly
   * set/changed — an unchanged rung was already validated at publish); password-for-
   * password access; the public-link admin gates (instance switch + per-account grant)
   * whenever the op creates or widens a public link; `requireExpiry` on the resulting
   * shareable state; and the bounds on a newly-set expiry. Returns null when valid.
   */
  async function validateGates(
    pol: Awaited<ReturnType<typeof policy>>,
    // The public-link entitlement follows the canvas OWNER's account, whoever acts
    // (editor-roles plan, KD7/R10); `actorIsOwner` picks the refusal wording (KTD6).
    entitlement: {
      ownerCanPublishPublic: boolean;
      actorIsOwner: boolean;
      publicLinksEnabled: boolean;
    },
    s: {
      /** True when this request explicitly sets the access rung (publish: always). */
      accessExplicit: boolean;
      /** The mapped rung the request explicitly requested (meaningful when accessExplicit). */
      requestedRung?: AccessRung;
      /** True when the caller explicitly asked for "password" access (password-required check). */
      wantsPasswordAccess: boolean;
      /** The share's rung AFTER this op. */
      effectiveRung: AccessRung;
      /** The share's password state AFTER this op. */
      willHavePassword: boolean;
      /** Run the public-link admin gate — set when the op creates or widens a public link. */
      runPublicLinkGate: boolean;
      /** The share's expiry AFTER this op (null = none). */
      effectiveExpiry: number | null;
      /** A NEW expiry value being set this request (number → bounds-checked; else omit). */
      newExpiry?: number;
      now: number;
    },
  ): Promise<ValidationError | null> {
    if (s.accessExplicit && s.requestedRung && !pol.allowedRungs.includes(s.requestedRung)) {
      return {
        code: "INVALID_BODY",
        message: `access rung "${s.requestedRung}" is not allowed`,
        status: 400,
      };
    }
    if (s.wantsPasswordAccess && !s.willHavePassword) {
      return {
        code: "INVALID_BODY",
        message: "password required for password access",
        status: 400,
      };
    }
    if (s.runPublicLinkGate) {
      if (!entitlement.publicLinksEnabled) {
        return {
          code: "PUBLIC_LINKS_DISABLED",
          message: "Public links are disabled for this instance.",
          status: 403,
        };
      }
      if (!entitlement.ownerCanPublishPublic) {
        return entitlement.actorIsOwner
          ? {
              code: "PUBLIC_NOT_ALLOWED",
              message:
                "An administrator has revoked this account's permission to publish public links.",
              status: 403,
            }
          : {
              code: "PUBLIC_LINK_OWNER_GATED",
              message:
                "The owner's account can't publish public links, so this share can't be made public. An administrator can grant it to the owner.",
              status: 403,
            };
      }
    }
    if (pol.requireExpiry && s.effectiveRung !== "private" && s.effectiveExpiry === null) {
      return { code: "INVALID_BODY", message: "an expiry is required", status: 400 };
    }
    if (typeof s.newExpiry === "number") {
      if (s.newExpiry <= s.now) {
        return { code: "INVALID_BODY", message: "expiresAt is in the past", status: 400 };
      }
      if (pol.maxExpiryDays > 0 && s.newExpiry > s.now + pol.maxExpiryDays * 86_400_000) {
        return { code: "INVALID_BODY", message: "expiresAt exceeds the maximum", status: 400 };
      }
    }
    return null;
  }

  /** Parse the multipart body → JSON metadata part + (optional) bundle File. */
  async function parseForm(
    c: import("hono").Context<AppEnv>,
    bundleRequired: boolean,
  ): Promise<{ metaJson: unknown; bundle: File | null } | ValidationError> {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return { code: "INVALID_BODY", message: "expected multipart/form-data", status: 400 };
    }
    const metaRaw = form.get("metadata");
    const bundle = form.get("bundle");
    if (typeof metaRaw !== "string") {
      return { code: "INVALID_BODY", message: "metadata required", status: 400 };
    }
    if (bundleRequired && !(bundle instanceof File)) {
      return { code: "INVALID_BODY", message: "bundle required", status: 400 };
    }
    let metaJson: unknown;
    try {
      metaJson = JSON.parse(metaRaw);
    } catch {
      return { code: "INVALID_BODY", message: "metadata is not valid JSON", status: 400 };
    }
    return { metaJson, bundle: bundle instanceof File ? bundle : null };
  }

  const metadataTooLarge = (m: unknown) =>
    m !== undefined && Buffer.byteLength(JSON.stringify(m), "utf8") > AUTHORING_MAX_METADATA_BYTES;

  const bundleLimit = bodyLimit({
    maxSize: AUTHORING_MAX_BUNDLE_BYTES,
    onError: (c) => c.json({ code: "INVALID_BODY", message: "bundle too large" }, 413),
  });

  // ── POST / — publish (create + deploy + configure a new share) ──────────────
  app.post("/", bundleLimit, async (c) => {
    const viewer = requireMember(c);
    if (!viewer) return c.json({ code: "NOT_AUTHENTICATED" }, 401);
    const source = requireCanvas(c); // canvas A (the page the viewer is on)

    const form = await parseForm(c, true);
    if ("code" in form) return c.json(form, form.status);
    const parsed = publishMeta.safeParse(form.metaJson);
    if (!parsed.success) return c.json({ code: "INVALID_BODY" }, 400);
    const meta = parsed.data;
    const bundle = form.bundle as File;
    if (bundle.size === 0) return c.json({ code: "INVALID_BODY", message: "empty bundle" }, 400);
    if (metadataTooLarge(meta.metadata)) {
      return c.json({ code: "INVALID_BODY", message: "metadata too large" }, 400);
    }

    const pol = await policy();
    const now = Date.now();
    const publicLinksEnabled = deps.publicLinksEnabled ? await deps.publicLinksEnabled() : true;
    // A fresh share always sets its rung (defaulting to private), so validate that
    // resolved rung — an omitted access is checked against allowedRungs just like an
    // explicit one — and enforce requireExpiry on the resulting shareable state.
    const requestedAccess = meta.access ?? "private";
    const rung: AccessRung = requestedAccess === "password" ? "public_link" : requestedAccess;
    const home = resolveHomeOrg(undefined, c.get("orgIds") ?? new Set<string>());
    if ("error" in home) return c.json({ code: "INVALID_BODY", reason: home.error }, 400);
    // Mirror resolveSettingsUpdate's ORG_REQUIRED guard: this route writes `access`
    // via the repo directly, so without this an org-less viewer under active tenancy
    // could mint a whole_org share that decideCanvasAccess denies to everyone.
    if (rung === "whole_org" && deps.config.org.name && home.orgId === null) {
      return c.json(
        {
          code: "ORG_REQUIRED",
          message: "Only a canvas homed in an org can be shared with the whole org.",
        },
        409,
      );
    }
    // A fresh share is the viewer's own canvas: the viewer IS the owner.
    const gateErr = await validateGates(
      pol,
      { ownerCanPublishPublic: viewer.canPublishPublic, actorIsOwner: true, publicLinksEnabled },
      {
        accessExplicit: true,
        requestedRung: rung,
        wantsPasswordAccess: requestedAccess === "password",
        effectiveRung: rung,
        willHavePassword: !!meta.password,
        runPublicLinkGate: rung === "public_link",
        effectiveExpiry: meta.expiresAt ?? null,
        newExpiry: meta.expiresAt,
        now,
      },
    );
    if (gateErr) return c.json(gateErr, gateErr.status);

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

    const resolved = await resolveCreateSlug(meta.slug, (s) => deps.canvases.slugTaken(s));
    if ("error" in resolved) return c.json({ code: "INVALID_BODY", reason: resolved.error }, 400);

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
      if (resolved.custom && isUniqueViolation(err, SLUG_UNIQUE)) {
        return c.json({ code: "SLUG_TAKEN", message: "That slug is already taken." }, 409);
      }
      c.get("log")?.error({ err }, "authoring: create failed");
      return c.json({ code: "PUBLISH_FAILED", message: "could not create the canvas" }, 502);
    }

    // Meter on CREATION — the canvas row + slug are the bounded resource, so a later
    // deploy/config failure still counts against quota. Audited here too.
    await deps.authoringUsage.record({
      actorId: viewer.id,
      sourceCanvasId: source.id,
      authoredCanvasId: canvasB.id,
    });
    deps.audit.recordAudit({
      action: "canvas_authored",
      actorId: viewer.id,
      targetId: canvasB.id,
      meta: { sourceCanvasId: source.id, requestedAccess },
    });

    try {
      const buffer = Buffer.from(await bundle.arrayBuffer());
      await deps.engine.deploy(canvasB, "api", fromZip(buffer), viewer.id);
    } catch (err) {
      c.get("log")?.error({ err, id: canvasB.id }, "authoring: deploy failed");
      return c.json({ code: "PUBLISH_FAILED", id: canvasB.id, message: "deploy failed" }, 502);
    }

    // Configure through the canonical settings resolver and ONE atomic row write, so
    // audience and password are orthogonal and gallery/discoverability invariants match
    // dashboard/MCP updates.
    let finalCv: Canvas;
    try {
      const deployed = (await deps.canvases.findById(canvasB.id)) ?? canvasB;
      const resolution = resolveSettingsUpdate(
        deployed,
        {
          access: rung,
          password: meta.password,
          tags: meta.tags,
          sharedExpiresAt: meta.expiresAt,
        },
        {
          publicLinksEnabled,
          ownerCanPublishPublic: viewer.canPublishPublic,
          actorIsOwner: true,
          publicEdgeCacheTtlSec: deps.config.serving.publicEdgeCacheTtlSec,
          now,
          tenancyActive: !!deps.config.org.name,
        },
      );
      if (!resolution.ok) {
        return c.json({ code: resolution.code, message: resolution.message }, resolution.status);
      }
      if (meta.metadata !== undefined) resolution.patch.metadata = meta.metadata as Json;
      finalCv = (await deps.canvases.updateSettingsAtomic(canvasB.id, resolution.patch, {
        passwordHash: await hashPasswordMutation(resolution.password),
      })) as Canvas;
    } catch (err) {
      c.get("log")?.error({ err, id: canvasB.id }, "authoring: configure failed");
      return c.json({ code: "PUBLISH_FAILED", id: canvasB.id, message: "configure failed" }, 502);
    }

    if (finalCv.access !== rung) {
      c.get("log")?.error(
        { id: canvasB.id, requestedAccess: rung, persistedAccess: finalCv.access },
        "authoring: requested access was not persisted",
      );
      return c.json(
        {
          code: "PUBLISH_FAILED",
          id: canvasB.id,
          message: "requested share settings were not persisted",
        },
        502,
      );
    }

    return c.json(await toAuthoredCanvas(finalCv, "owner"));
  });

  // ── PUT /:id — update in place (new version and/or settings; stable URL) ─────
  app.put("/:id", bundleLimit, async (c) => {
    const viewer = requireMember(c);
    if (!viewer) return c.json({ code: "NOT_AUTHENTICATED" }, 401);
    const id = c.req.param("id");
    // Owner or editor (admin allowance kept, KTD12); a non-managed / missing id reads as
    // not-found (no existence leak).
    const managed = await managedShare(c, id, viewer);
    if (!managed) return c.json({ code: "NOT_FOUND" }, 404);
    const cv = managed.canvas;
    // An admin takedown makes the canvas read-only everywhere (§12.0 #5) — the role is
    // checked first (above), so this 409 never leaks a non-managed row's existence.
    if (cv.status === "disabled") return c.json(disabledError(cv), 409);
    const form = await parseForm(c, false);
    if ("code" in form) return c.json(form, form.status);
    const parsed = updateMeta.safeParse(form.metaJson);
    if (!parsed.success) return c.json({ code: "INVALID_BODY" }, 400);
    const meta = parsed.data;
    if (form.bundle && form.bundle.size === 0) {
      return c.json({ code: "INVALID_BODY", message: "empty bundle" }, 400);
    }
    if (cv.revokedAt != null && !form.bundle) {
      return c.json(
        {
          code: "SHARE_REVOKED",
          message: "This share is unpublished; include a bundle to publish it again.",
        },
        409,
      );
    }
    if (metadataTooLarge(meta.metadata)) {
      return c.json({ code: "INVALID_BODY", message: "metadata too large" }, 400);
    }

    const pol = await policy();
    const now = Date.now();
    const publicLinksEnabled = deps.publicLinksEnabled ? await deps.publicLinksEnabled() : true;
    // Resolve the share's END STATE (not just the changed fields) so the gate catches
    // exposure-widening updates — clearing a password on a public link, or dropping the
    // expiry on a shareable rung — that a field-only check would wave through.
    const requestedAccess = meta.access;
    const rung: AccessRung | undefined =
      requestedAccess === undefined
        ? undefined
        : requestedAccess === "password"
          ? "public_link"
          : requestedAccess;
    const effectiveRung = (rung ?? cv.access) as AccessRung;
    // Mirror resolveSettingsUpdate's ORG_REQUIRED guard (same rationale as publish):
    // an org-less canvas under active tenancy must not switch to whole_org — that
    // rung would be a dead share decideCanvasAccess denies to everyone.
    if (rung === "whole_org" && deps.config.org.name && cv.orgId === null) {
      return c.json(
        {
          code: "ORG_REQUIRED",
          message: "Only a canvas homed in an org can be shared with the whole org.",
        },
        409,
      );
    }
    // Password state after this op: provided string sets it; null clears; undefined keeps.
    const willHavePassword =
      meta.password !== undefined ? meta.password !== null : cv.passwordHash != null;
    const passwordCleared = meta.password === null && cv.passwordHash != null;
    // Expiry after this op: undefined keeps the row's, null clears it, a number sets it.
    const effectiveExpiry =
      meta.expiresAt === undefined ? (cv.sharedExpiresAt ?? null) : meta.expiresAt;
    const ownerCanPublishPublic = await deps.canvases.isOwnerPublishEnabled(cv.ownerId);
    const gateErr = await validateGates(
      pol,
      {
        ownerCanPublishPublic,
        actorIsOwner: managed.role === "owner",
        publicLinksEnabled,
      },
      {
        accessExplicit: requestedAccess !== undefined,
        requestedRung: rung,
        wantsPasswordAccess: requestedAccess === "password",
        effectiveRung,
        willHavePassword,
        // Re-run the public-link admin gate whenever the op creates or WIDENS a public link
        // (access set to public_link/password, or a password cleared on an existing one) —
        // never on a benign edit of an already-open share.
        runPublicLinkGate:
          effectiveRung === "public_link" && (requestedAccess !== undefined || passwordCleared),
        effectiveExpiry,
        newExpiry: typeof meta.expiresAt === "number" ? meta.expiresAt : undefined,
        now,
      },
    );
    if (gateErr) return c.json(gateErr, gateErr.status);

    // Resolve authoring through the same canonical settings rules as dashboard/MCP.
    // A revoked share with a supplied bundle is about to be published, so validate its
    // requested post-deploy audience against that planned state.
    const plannedCv =
      form.bundle && cv.currentVersionId === null ? { ...cv, currentVersionId: "pending" } : cv;
    const settings = resolveSettingsUpdate(
      plannedCv,
      {
        title: meta.title,
        access: rung,
        password: meta.password,
        sharedExpiresAt: meta.expiresAt,
        tags: meta.tags,
      },
      {
        publicLinksEnabled,
        ownerCanPublishPublic,
        actorIsOwner: managed.role === "owner",
        publicEdgeCacheTtlSec: deps.config.serving.publicEdgeCacheTtlSec,
        now,
        tenancyActive: !!deps.config.org.name,
      },
    );
    if (!settings.ok) {
      return c.json({ code: settings.code, message: settings.message }, settings.status);
    }
    if (meta.metadata !== undefined) settings.patch.metadata = meta.metadata as Json;

    const passwordHash = await hashPasswordMutation(settings.password);
    // Team grants live on the people-and-teams list and apply at every rung (restricted
    // access model): a rung change never touches them, so no viewer-team write rides along.
    const conflictResponse = async () => {
      const current = await deps.canvases.findById(cv.id);
      return c.json(
        {
          code: "SHARE_CONFLICT",
          message: "This share changed since it was loaded. Refresh and try again.",
          current: current ? await toAuthoredCanvas(current, managed.role) : null,
        },
        409,
      );
    };

    let finalCv: Canvas | undefined;
    if (form.bundle) {
      let activationConflict = false;
      try {
        const buffer = Buffer.from(await form.bundle.arrayBuffer());
        await deps.engine.deploy(cv, "api", fromZip(buffer), viewer.id, {
          activateVersion: async (versionId) => {
            finalCv = await deps.canvases.updateSettingsAtomic(cv.id, settings.patch, {
              passwordHash,
              expectedUpdatedAt: meta.expectedUpdatedAt,
              currentVersionId: versionId,
            });
            if (!finalCv) {
              activationConflict = true;
              throw new Error("authoring share changed before activation");
            }
          },
        });
      } catch (err) {
        if (activationConflict) return conflictResponse();
        c.get("log")?.error({ err, id: cv.id }, "authoring: update deploy failed");
        return c.json(
          { code: "PUBLISH_FAILED", id: cv.id, message: "The new bundle was not published." },
          502,
        );
      }
    } else {
      try {
        finalCv = await deps.canvases.updateSettingsAtomic(cv.id, settings.patch, {
          passwordHash,
          expectedUpdatedAt: meta.expectedUpdatedAt,
        });
      } catch (err) {
        c.get("log")?.error({ err, id: cv.id }, "authoring: update configure failed");
        return c.json({ code: "PUBLISH_FAILED", id: cv.id, message: "configure failed" }, 502);
      }
      if (!finalCv) return conflictResponse();
    }

    if (!finalCv) {
      c.get("log")?.error({ id: cv.id }, "authoring: update completed without activation state");
      return c.json({ code: "PUBLISH_FAILED", id: cv.id, message: "update failed" }, 502);
    }

    if (rung !== undefined && finalCv.access !== rung) {
      c.get("log")?.error(
        { id: cv.id, requestedAccess: rung, persistedAccess: finalCv.access },
        "authoring: requested access was not persisted",
      );
      return c.json(
        {
          code: "PUBLISH_FAILED",
          id: cv.id,
          message: "requested share settings were not persisted",
        },
        502,
      );
    }

    deps.audit.recordAudit({
      action: "canvas_authored_update",
      actorId: viewer.id,
      targetId: cv.id,
      meta: { requestedAccess: requestedAccess ?? null, persistedAccess: finalCv.access },
    });
    return c.json(await toAuthoredCanvas(finalCv, managed.role));
  });

  // ── GET / — list the viewer's authored shares (+ filter) ────────────────────
  app.get("/", async (c) => {
    const viewer = requireMember(c);
    if (!viewer) return c.json({ code: "NOT_AUTHENTICATED" }, 401);
    const orgIds = c.get("orgIds") ?? new Set<string>();
    const ids = await deps.authoringUsage.authoredIdsAmong(
      await deps.canvases.listManagedCanvasIds(viewer.id, {
        tenancyActive: !!deps.config.org.name,
        viewerOrgIds: orgIds,
      }),
    );
    const rowsById = new Map(
      (await deps.canvases.findByIds(ids)).map((canvas) => [canvas.id, canvas]),
    );
    const rows = ids.map((id) => rowsById.get(id) ?? null);
    // Include unpublished shares (they stay `active` + revoked_at), but keep the
    // authoring view aligned with the dashboard's active-canvas view: archived,
    // deleted, and admin-disabled canvases are not reusable shares. Exclude any the
    // viewer no longer manages (owner or editor — a share whose ownership moved away
    // stays listed while the author remains an editor).
    const principal = memberPrincipal(viewer, orgIds);
    const grants = await Promise.all(
      rows.map(async (cv): Promise<RoleGrant | null> => {
        if (cv?.status !== "active") return null;
        return resolveManagementGrant(cv, principal, roleDeps);
      }),
    );
    const fSourceApp = c.req.query("sourceApp");
    const fSourceKind = c.req.query("sourceKind");
    const fTags = (c.req.query("tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const matchingGrants = grants
      .filter((g): g is RoleGrant => g !== null)
      .filter(({ canvas }) => {
        const metadata = (canvas.metadata ?? {}) as Record<string, unknown>;
        const tags = (canvas.tags as string[] | null) ?? [];
        return (
          (!fSourceApp || metadata.sourceApp === fSourceApp) &&
          (!fSourceKind || metadata.sourceKind === fSourceKind) &&
          (!fTags.length || fTags.every((tag) => tags.includes(tag)))
        );
      });
    // Project audience details only after the cheap source/tag filters. Team and
    // specific-people summaries require extra repository reads per matching share.
    const shares = await Promise.all(
      matchingGrants.map((grant) => toAuthoredCanvas(grant.canvas, grant.role)),
    );

    c.header("Cache-Control", "private, no-store");
    return c.json({ canvases: shares });
  });

  // ── DELETE /:id — revoke (URL unreadable; record stays listed as "revoked") ──
  app.delete("/:id", async (c) => {
    const viewer = requireMember(c);
    if (!viewer) return c.json({ code: "NOT_AUTHENTICATED" }, 401);
    const id = c.req.param("id");
    // Owner or editor (admin allowance kept, KTD12); a non-managed / missing id reads as
    // not-found (no existence leak).
    const managed = await managedShare(c, id, viewer);
    if (!managed) return c.json({ code: "NOT_FOUND" }, 404);
    const cv = managed.canvas;
    // A disabled (admin-taken-down) canvas is read-only to its owner (§12.0 #5) — parity
    // with every management mutation, which refuses through mutableCanvas.
    if (cv.status === "disabled") return c.json(disabledError(cv), 409);
    // set revoked_at + unpublish + close the anonymous-public surface; row stays listed.
    // Honor the return: a non-active row (e.g. archived) is a no-op → 404, not a false 204.
    const revoked = await deps.canvases.revoke(cv.id);
    if (!revoked) return c.json({ code: "NOT_FOUND" }, 404);
    deps.audit.recordAudit({
      action: "canvas_authored_revoke",
      actorId: viewer.id,
      targetId: cv.id,
    });
    return c.body(null, 204);
  });

  return app;
}

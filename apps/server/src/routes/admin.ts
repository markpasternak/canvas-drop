import type { Config } from "@canvas-drop/shared";
import type { Canvas, CanvasStatus } from "@canvas-drop/shared/db";
import { publicationState } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { z } from "zod";
import { requireAdmin } from "../admin/authz.js";
import {
  type AdminSettingsService,
  PUBLIC_LINKS_ENABLED_KEY,
  QUOTA_KEYS,
  type QuotaKey,
} from "../admin/settings-service.js";
import type { AuditLog } from "../audit/audit-log.js";
import { MAX_CANVAS_BYTES, MAX_FILE_BYTES } from "../canvas/files-service.js";
import { canvasUrl } from "../canvas/url.js";
import type { AdminCanvasStatus, AdminRepository } from "../db/repositories/admin.js";
import type { AiUsageRepository } from "../db/repositories/ai-usage.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { EmailTemplatesRepository } from "../db/repositories/email-templates.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS } from "../email/templates.js";
import { requireSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
import type { InviteService } from "../invites/service.js";
import { KV_MAX_KEYS_SHARED, KV_MAX_KEYS_USER } from "./canvas-kv.js";

export interface AdminRoutesDeps {
  config: Config;
  admin: AdminRepository;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  users: UsersRepository;
  files: FilesRepository;
  aiUsage: AiUsageRepository;
  settings: AdminSettingsService;
  allowedEmails: AllowedEmailsRepository;
  /** Admin-editable email templates (plan 003 phase 3). */
  emailTemplates: EmailTemplatesRepository;
  /** The invite primitive (plan 003 U5) — Add-users permits + invites through it (so the new
   *  email gets a courtesy email and, on a matching domain, org membership on first login). */
  invites: InviteService;
  audit: AuditLog;
  /** Revoke a user's live MCP OAuth tokens (called on block) so the agent control
   *  plane honors the block instantly, not just on the token's next use. */
  revokeMcpTokensForUser?: (userId: string) => Promise<void>;
}

const STATUSES = ["active", "disabled", "archived", "deleted"] as const;
const ACCESS_RUNGS = ["private", "specific_people", "team", "whole_org", "public_link"] as const;
const CANVAS_SORTS = ["recent", "created", "title"] as const;
// `"true"` ⇒ on; anything else (absent / "false") ⇒ off. Boolean facets are
// presence-style flags in the URL (?templatable=true), mirroring the member list.
const boolFlag = z
  .union([z.literal("true"), z.literal("false")])
  .optional()
  .transform((v) => v === "true");
const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  access: z.enum(ACCESS_RUNGS).optional(),
  templatable: boolFlag,
  listed: boolFlag,
  q: z.string().trim().max(200).optional(),
  owner: z.string().trim().max(100).optional(),
  sort: z.enum(CANVAS_SORTS).optional().default("recent"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
const USER_SORTS = ["active", "created", "name", "canvases"] as const;
const userListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  sort: z.enum(USER_SORTS).optional().default("active"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});
const disableBody = z.object({ reason: z.string().trim().min(1).max(500) });
const featureBody = z.object({ featured: z.boolean() });
const modelsBody = z.object({ models: z.array(z.string().min(1)).min(1) });
const quotasBody = z.object({
  quotas: z.record(z.string(), z.number().finite().positive()),
});
// A config override value: string | number | boolean | string[] (per the field's
// type — the settings service validates/coerces against the registry).
const configBody = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});

/** An email-template override body (plan 003 phase 3). Bodies are bounded; the renderer
 *  HTML-escapes interpolated values, so an admin can paste HTML here intentionally. */
const templateBody = z.object({
  subject: z.string().trim().min(1).max(300),
  bodyHtml: z.string().max(20_000),
  bodyText: z.string().max(20_000),
});

/** The hard fallback for each admin-tunable quota key (KV/files constants; AI from config). */
function quotaFallback(config: Config, key: QuotaKey): number {
  switch (key) {
    case "kv.keys.shared":
      return KV_MAX_KEYS_SHARED;
    case "kv.keys.user":
      return KV_MAX_KEYS_USER;
    case "files.bytes.file":
      return MAX_FILE_BYTES;
    case "files.bytes.canvas":
      return MAX_CANVAS_BYTES;
    case "ai.user.daily.usd":
      return config.ai.userDailyUsd;
    case "ai.canvas.monthly.usd":
      return config.ai.canvasMonthlyUsd;
  }
}

/**
 * Admin-only management surface (§6.10, M7), mounted at `/api/admin`. The whole
 * router is behind `requireAdmin` (server-resolved `isAdmin`, 404 to non-admins —
 * no existence leak). Mutations are same-origin-guarded and audited. The
 * management `{ error }` envelope (not the runtime `{ code }`). The cross-owner
 * reads here are the ONLY non-owner-scoped canvas reads in the app.
 */
export function adminRoutes(deps: AdminRoutesDeps) {
  const app = new Hono<AppEnv>();
  const sameOrigin = requireSameOrigin(deps.config);

  async function applyConfigSideEffects(key: string): Promise<void> {
    if (key !== PUBLIC_LINKS_ENABLED_KEY) return;
    if (await deps.settings.effectivePublicLinksEnabled()) return;
    await deps.canvases.revertAllPublicLinks();
  }

  app.use("*", requireAdmin());

  // --- All-canvases list (§6.10.1): owner / status / size / usage / last-activity.
  //     Member-parity filter/search/sort + offset paging (plan 006). ---
  app.get("/canvases", async (c) => {
    const q = listQuery.safeParse({
      status: c.req.query("status"),
      access: c.req.query("access"),
      templatable: c.req.query("templatable"),
      listed: c.req.query("listed"),
      q: c.req.query("q"),
      owner: c.req.query("owner"),
      sort: c.req.query("sort"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!q.success) return c.json({ error: "invalid_query" }, 400);

    const { items: rows, total } = await deps.admin.listAllCanvasesFiltered({
      status: q.data.status as AdminCanvasStatus | undefined,
      access: q.data.access,
      templatable: q.data.templatable,
      listed: q.data.listed,
      q: q.data.q,
      owner: q.data.owner,
      sort: q.data.sort,
      limit: q.data.limit,
      offset: q.data.offset,
    });

    const ids = rows.map((cv) => cv.id);
    const ownerIds = [...new Set(rows.map((cv) => cv.ownerId))];
    const versionIds = rows
      .map((cv) => cv.currentVersionId)
      .filter((id): id is string => id !== null);
    const [owners, versions, fileBytes, usage] = await Promise.all([
      deps.users.findByIds(ownerIds),
      deps.versions.findByIds(versionIds),
      deps.files.bytesByCanvas(ids),
      deps.admin.usageCountByCanvas(ids),
    ]);
    const ownerById = new Map(owners.map((u) => [u.id, u]));
    const versionById = new Map(versions.map((v) => [v.id, v]));

    const canvases = rows.map((cv) => {
      const owner = ownerById.get(cv.ownerId);
      const version = cv.currentVersionId ? versionById.get(cv.currentVersionId) : undefined;
      const deployedBytes = version?.totalBytes ?? 0;
      return {
        id: cv.id,
        slug: cv.slug,
        url: canvasUrl(deps.config, cv.slug),
        title: cv.title,
        status: cv.status,
        access: cv.access,
        publicationState: publicationState(cv.status as CanvasStatus, cv.currentVersionId !== null),
        // Gallery-listed flag — the client only offers "Feature in gallery" for a
        // listed+published row (the server enforces the same on the feature route).
        galleryListed: cv.galleryListed,
        // Clone-as-template flag — surfaced so the table shows + filters by template.
        galleryTemplatable: cv.galleryTemplatable,
        // Admin-curated editorial flag (KTD3) — surfaced so the table reflects the
        // featured state and the Feature toggle can flip it in place.
        galleryFeatured: cv.galleryFeatured,
        disabledReason: cv.disabledReason,
        // Open-gate inputs for the dashboard (boolean only — never the hash itself):
        // whether a password is set, and the share-link expiry (null = no expiry).
        hasPassword: cv.passwordHash !== null,
        sharedExpiresAt: cv.sharedExpiresAt,
        owner: owner ? { id: owner.id, email: owner.email, name: owner.name } : null,
        // Size = deployed version bytes + uploaded file bytes (§6.10.1).
        sizeBytes: deployedBytes + (fileBytes.get(cv.id) ?? 0),
        usageOps: usage.get(cv.id) ?? 0,
        // Last activity proxy: updatedAt bumps on deploy/settings/status changes.
        lastActivityAt: cv.updatedAt,
        createdAt: cv.createdAt,
        // Soft-delete timestamp (purge factors on it); null unless status='deleted'.
        deletedAt: cv.deletedAt,
      };
    });
    // `total` echoed (with limit/offset) so the UI derives "showing X–Y of N" from
    // authoritative values, mirroring the gallery / Your-canvases lists.
    return c.json({ canvases, total, limit: q.data.limit, offset: q.data.offset });
  });

  // --- Platform usage overview (§6.10.6): totals + top canvases + AI spend ---
  app.get("/overview", async (c) => {
    const [stats, ai] = await Promise.all([
      deps.admin.platformStats(10),
      deps.aiUsage.platformSpend(),
    ]);
    // Enrich the top canvases with slug/title via one batched lookup (no N+1). A
    // missing canvas simply isn't in the map → null slug/title for that row.
    const topCanvases = await deps.canvases
      .findByIds(stats.topCanvases.map((t) => t.canvasId))
      .catch(() => []);
    const topById = new Map(topCanvases.map((cv) => [cv.id, cv]));
    const top = stats.topCanvases.map((t) => {
      const cv = topById.get(t.canvasId);
      return {
        canvasId: t.canvasId,
        ops: t.ops,
        slug: cv?.slug ?? null,
        title: cv?.title ?? null,
      };
    });
    return c.json({
      canvasCountByStatus: stats.canvasCountByStatus,
      publicLinkCount: stats.publicLinkCount,
      userCount: stats.userCount,
      totalFileBytes: stats.totalFileBytes,
      totalOps: stats.totalOps,
      totalViews: stats.totalViews,
      uniqueViewers: stats.uniqueViewers,
      totalDeploys: stats.totalDeploys,
      newCanvases: stats.newCanvases,
      newUsers: stats.newUsers,
      recentWindowDays: stats.recentWindowDays,
      oldestDeletedAt: stats.oldestDeletedAt,
      topCanvases: top,
      aiCostUsd: ai.costUsd,
      aiTokens: ai.inputTokens + ai.outputTokens,
      aiCalls: ai.calls,
    });
  });

  // --- AI usage breakdown (§6.10.7): top-spending canvases (and their owners).
  //     Re-attributed to canvas/owner only — NOT to the calling user. "Governance
  //     without surveillance": an admin sees WHICH canvas/owner is burning AI spend
  //     (a cost/abuse object fact), never which member made which call (plan 006). ---
  app.get("/ai-usage", async (c) => {
    const byCanvasRaw = await deps.aiUsage.spendByCanvas(10);
    // Batched canvas + owner lookups (top-10), resilient like /overview: a missing
    // canvas falls back to null slug/title/owner, never a 500.
    const canvasRows = await deps.canvases
      .findByIds(byCanvasRaw.map((r) => r.id))
      .catch((): Canvas[] => []);
    const canvasById = new Map(canvasRows.map((cv) => [cv.id, cv]));
    const ownerIds = [...new Set(canvasRows.map((cv) => cv.ownerId))];
    const owners = await deps.users.findByIds(ownerIds);
    const emailById = new Map(owners.map((u) => [u.id, u.email]));
    const byCanvas = byCanvasRaw.map((r) => {
      const cv = canvasById.get(r.id);
      return {
        canvasId: r.id,
        slug: cv?.slug ?? null,
        title: cv?.title ?? null,
        ownerEmail: cv ? (emailById.get(cv.ownerId) ?? null) : null,
        costUsd: r.costUsd,
        calls: r.calls,
      };
    });
    return c.json({ byCanvas });
  });

  // --- Takedown / restore (§6.10.2, §6.10.5) ---

  app.post("/canvases/:id/disable", sameOrigin, async (c) => {
    const cv = await loadCanvas(deps, c.req.param("id"));
    if (!cv) return c.json({ error: "not_found" }, 404);
    const body = disableBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    if (!(await deps.canvases.setDisabled(cv.id, body.data.reason))) {
      // Only an active canvas can be taken down (archived/deleted already off).
      return c.json({ error: "not_active", message: "only an active canvas can be disabled" }, 409);
    }
    deps.audit.recordAudit({
      action: "canvas_disable",
      actorId: c.get("user").id,
      targetId: cv.id,
      meta: { reason: body.data.reason },
    });
    return c.json({ ok: true });
  });

  app.post("/canvases/:id/enable", sameOrigin, async (c) => {
    const cv = await loadCanvas(deps, c.req.param("id"));
    if (!cv) return c.json({ error: "not_found" }, 404);
    if (!(await deps.canvases.enable(cv.id))) {
      return c.json({ error: "not_disabled", message: "canvas is not disabled" }, 409);
    }
    deps.audit.recordAudit({
      action: "canvas_enable",
      actorId: c.get("user").id,
      targetId: cv.id,
    });
    return c.json({ ok: true });
  });

  app.post("/canvases/:id/restore", sameOrigin, async (c) => {
    // Distinct from the draft `POST /api/canvases/:id/restore` (revert-to-version):
    // this un-soft-deletes. Different mount base, named `adminRestoreCanvas` in the client.
    const id = c.req.param("id");
    if (!id) return c.json({ error: "not_found" }, 404);
    if (!(await deps.canvases.restore(id))) {
      return c.json({ error: "not_deleted", message: "canvas is not soft-deleted" }, 409);
    }
    deps.audit.recordAudit({
      action: "canvas_restore",
      actorId: c.get("user").id,
      targetId: id,
    });
    return c.json({ ok: true });
  });

  // --- Gallery curation (plan 2026-06-19 KTD3): set/unset the admin-curated
  //     `galleryFeatured` editorial flag. A cross-owner action (NOT the per-account
  //     owner check / MCP surface) — existence-404 like disable/enable/restore.
  //     Display/sort-only; never an authorization input. ---
  app.post("/canvases/:id/feature", sameOrigin, async (c) => {
    const cv = await loadCanvas(deps, c.req.param("id"));
    if (!cv) return c.json({ error: "not_found" }, 404);
    const body = featureBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    // Only a gallery-listed + published canvas can be FEATURED: the gallery's featured
    // row only ever shows listed+published+live canvases (the visibility predicate
    // filters the rest), so featuring anything else is a no-op the admin can't see.
    // Unfeaturing (featured=false) is ALWAYS allowed — it can never widen exposure and
    // must work to clear a stale flag left on a since-unlisted canvas.
    if (body.data.featured) {
      const published =
        publicationState(cv.status as CanvasStatus, cv.currentVersionId !== null) === "published";
      if (!cv.galleryListed || !published) {
        return c.json(
          {
            error: "not_listed",
            message: "Only gallery-listed canvases can be featured",
          },
          409,
        );
      }
    }
    await deps.canvases.setFeatured(cv.id, body.data.featured);
    deps.audit.recordAudit({
      action: "canvas_feature",
      actorId: c.get("user").id,
      targetId: cv.id,
      meta: { featured: body.data.featured },
    });
    return c.json({ ok: true });
  });

  // --- User management (plan 006). Identity + governance facts; block/unblock and
  //     promote/demote. NO per-user behavioral data is exposed. Mutations are
  //     same-origin-guarded, audited, and self-protected (server-side, not just a
  //     disabled button). ---

  app.get("/users", async (c) => {
    const q = userListQuery.safeParse({
      q: c.req.query("q"),
      sort: c.req.query("sort"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!q.success) return c.json({ error: "invalid_query" }, 400);
    const { items, total } = await deps.admin.listUsers({
      q: q.data.q,
      sort: q.data.sort,
      limit: q.data.limit,
      offset: q.data.offset,
    });
    return c.json({ users: items, total, limit: q.data.limit, offset: q.data.offset });
  });

  app.post("/users/:id/block", sameOrigin, async (c) => {
    const id = c.req.param("id");
    const actor = c.get("user");
    // Self-protection: you can never block yourself out of the platform.
    if (id === actor.id) return c.json({ error: "cannot_block_self" }, 400);
    const target = await deps.users.findById(id);
    if (!target) return c.json({ error: "not_found" }, 404);
    // Last-admin protection: blocking a functioning admin removes them from the
    // org just like a demote (the gateway rejects blocked users). Don't let it
    // strip the org of its final usable administrator. countAdmins() counts only
    // non-blocked admins, so it includes this still-active target.
    if (target.isAdmin && !target.isBlocked && (await deps.users.countAdmins()) <= 1) {
      return c.json({ error: "last_admin", message: "cannot block the last admin" }, 409);
    }
    await deps.users.setBlocked(id, true);
    // Kill any live MCP tokens immediately so the agent control plane honors the
    // block on the spot (the token surface also re-checks per call, defense in depth).
    await deps.revokeMcpTokensForUser?.(id);
    deps.audit.recordAudit({
      action: "user_block",
      actorId: actor.id,
      targetType: "user",
      targetId: id,
    });
    return c.json({ ok: true });
  });

  app.post("/users/:id/unblock", sameOrigin, async (c) => {
    const id = c.req.param("id");
    if (!(await deps.users.findById(id))) return c.json({ error: "not_found" }, 404);
    await deps.users.setBlocked(id, false);
    deps.audit.recordAudit({
      action: "user_unblock",
      actorId: c.get("user").id,
      targetType: "user",
      targetId: id,
    });
    return c.json({ ok: true });
  });

  app.post("/users/:id/promote", sameOrigin, async (c) => {
    const id = c.req.param("id");
    if (!(await deps.users.findById(id))) return c.json({ error: "not_found" }, 404);
    await deps.users.setAdmin(id, true);
    deps.audit.recordAudit({
      action: "user_promote",
      actorId: c.get("user").id,
      targetType: "user",
      targetId: id,
    });
    return c.json({ ok: true });
  });

  app.post("/users/:id/demote", sameOrigin, async (c) => {
    const id = c.req.param("id");
    const actor = c.get("user");
    // Self-protection #1: you can't demote yourself (avoids accidental lockout).
    if (id === actor.id) return c.json({ error: "cannot_demote_self" }, 400);
    const target = await deps.users.findById(id);
    if (!target) return c.json({ error: "not_found" }, 404);
    // Self-protection #2: never demote the last functioning admin — a single click
    // must not leave the org with no usable administrator. A blocked target isn't
    // counted by countAdmins(), so demoting them can't drop the functioning count.
    if (target.isAdmin && !target.isBlocked && (await deps.users.countAdmins()) <= 1) {
      return c.json({ error: "last_admin", message: "cannot demote the last admin" }, 409);
    }
    await deps.users.setAdmin(id, false);
    deps.audit.recordAudit({
      action: "user_demote",
      actorId: actor.id,
      targetType: "user",
      targetId: id,
    });
    return c.json({ ok: true });
  });

  // Grant/revoke the publish-public capability (U10/R19-R20). Revoking sweeps the
  // account's public_link canvases back to private so revocation is immediate.
  app.post("/users/:id/grant-public", sameOrigin, async (c) => {
    const id = c.req.param("id");
    if (!(await deps.users.findById(id))) return c.json({ error: "not_found" }, 404);
    await deps.users.setPublishPublic(id, true);
    deps.audit.recordAudit({
      action: "user_grant_public",
      actorId: c.get("user").id,
      targetType: "user",
      targetId: id,
    });
    return c.json({ ok: true });
  });

  app.post("/users/:id/revoke-public", sameOrigin, async (c) => {
    const id = c.req.param("id");
    if (!(await deps.users.findById(id))) return c.json({ error: "not_found" }, 404);
    await deps.users.setPublishPublic(id, false);
    await deps.canvases.revertPublicForOwner(id);
    deps.audit.recordAudit({
      action: "user_revoke_public",
      actorId: c.get("user").id,
      targetType: "user",
      targetId: id,
    });
    return c.json({ ok: true });
  });

  // --- Sign-in email allowlist (D14 supplement): individual emails that may sign in
  //     even when their domain isn't in CANVAS_DROP_ALLOWED_EMAIL_DOMAINS. The env
  //     domain list is unchanged; this is an additive, admin-managed layer. ---
  const allowedEmailBody = z.object({
    email: z
      .string()
      .email()
      .transform((e) => e.trim().toLowerCase()),
  });

  app.get("/allowed-emails", async (c) => {
    return c.json({ emails: await deps.allowedEmails.list() });
  });

  // Add users (plan 003 U7) — the only way to permit a brand-new email to sign in. Routes
  // through the invite primitive with the admin allowance: it permits the email (an
  // `allowed_emails` row when the domain doesn't already authenticate), records nothing to
  // materialize (org membership auto-derives from the domain on first login), and sends a
  // courtesy email. Existing allowlist entries keep working — this replaces the bare add.
  app.post("/allowed-emails", sameOrigin, async (c) => {
    const body = allowedEmailBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const user = c.get("user");
    const r = await deps.invites.resolveOrInvite({ kind: "account" }, body.data.email, {
      id: user.id,
      name: user.name,
      email: user.email,
      isAdmin: user.isAdmin,
    });
    if (r.status === "auth_admission_required") {
      return c.json(
        {
          code: "AUTH_ADMISSION_REQUIRED",
          message: "That email must be admitted by the configured identity provider first.",
        },
        403,
      );
    }
    if (r.status === "blocked") {
      return c.json({ code: "BLOCKED", message: "That account is blocked." }, 403);
    }
    if (r.status === "rate_limited") {
      return c.json({ code: "RATE_LIMITED", message: "Too many invites — try again later." }, 429);
    }
    deps.audit.recordAudit({
      action: "allowed_email_add",
      actorId: user.id,
      meta: { email: body.data.email.trim().toLowerCase() },
    });
    // Surface the resulting allowlist entry when one was created (off-domain email) so the
    // panel can show it; a domain-matched email needs no row (it already authenticates).
    const status =
      r.status === "granted" ||
      r.status === "already_added" ||
      r.status === "pending" ||
      r.status === "already_pending"
        ? r.status
        : "pending";
    const entry =
      (await deps.allowedEmails.list()).find(
        (e) => e.email === body.data.email.trim().toLowerCase(),
      ) ?? null;
    return c.json({ ok: true, status, entry });
  });

  app.delete("/allowed-emails/:id", sameOrigin, async (c) => {
    const id = c.req.param("id");
    await deps.allowedEmails.remove(id);
    deps.audit.recordAudit({
      action: "allowed_email_remove",
      actorId: c.get("user").id,
      meta: { id },
    });
    return c.json({ ok: true });
  });

  // --- AI model allowlist (§6.10.3) ---

  app.get("/settings/models", async (c) => {
    return c.json({
      models: await deps.settings.effectiveModels(),
      override: await deps.settings.getModelsOverride(),
      default: deps.config.ai.models,
    });
  });

  app.put("/settings/models", sameOrigin, async (c) => {
    const body = modelsBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    await deps.settings.setModels(body.data.models);
    deps.audit.recordAudit({
      action: "admin_settings_update",
      actorId: c.get("user").id,
      meta: { keys: ["ai.models.allowlist"] },
    });
    return c.json({ models: await deps.settings.effectiveModels() });
  });

  // --- Global quota defaults (§6.10.4) ---

  app.get("/settings/quotas", async (c) => {
    const quotas = await Promise.all(
      QUOTA_KEYS.map(async (key) => ({
        key,
        value: await deps.settings.effectiveQuota(key, quotaFallback(deps.config, key)),
        default: quotaFallback(deps.config, key),
        override: await deps.settings.getQuotaOverride(key),
      })),
    );
    return c.json({ quotas });
  });

  app.put("/settings/quotas", sameOrigin, async (c) => {
    const body = quotasBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const allowed = new Set<string>(QUOTA_KEYS);
    const keys = Object.keys(body.data.quotas);
    if (keys.length === 0 || keys.some((k) => !allowed.has(k))) {
      return c.json({ error: "invalid_quota_key" }, 400);
    }
    for (const key of keys) {
      // biome-ignore lint/style/noNonNullAssertion: key is in body.data.quotas
      await deps.settings.setQuota(key as QuotaKey, body.data.quotas[key]!);
    }
    deps.audit.recordAudit({
      action: "admin_settings_update",
      actorId: c.get("user").id,
      meta: { keys: keys.map((k) => `quota.${k}`) },
    });
    return c.json({ ok: true });
  });

  // --- Unified Configuration view (§6.10, this round) ---
  // Every setting with its effective value / source / secret-mask. Secrets carry
  // NO raw value, only configured + last-4. A safe subset is editable (DB override).

  app.get("/config", async (c) => {
    return c.json({ fields: await deps.settings.describeConfig() });
  });

  app.put("/config/:key", sameOrigin, async (c) => {
    const key = c.req.param("key");
    const body = configBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    try {
      await deps.settings.setConfigOverride(key, body.data.value);
      await applyConfigSideEffects(key);
    } catch (err) {
      return c.json({ error: "invalid_value", message: (err as Error).message }, 400);
    }
    // NEVER log the value — a setting may be a secret (e.g. the AI provider key).
    deps.audit.recordAudit({
      action: "admin_settings_update",
      actorId: c.get("user").id,
      meta: { keys: [`config.${key}`] },
    });
    return c.json({ ok: true });
  });

  app.delete("/config/:key", sameOrigin, async (c) => {
    const key = c.req.param("key");
    try {
      await deps.settings.clearConfigOverride(key);
      await applyConfigSideEffects(key);
    } catch (err) {
      return c.json({ error: "invalid_key", message: (err as Error).message }, 400);
    }
    deps.audit.recordAudit({
      action: "admin_settings_update",
      actorId: c.get("user").id,
      meta: { keys: [`config.${key}`, "cleared"] },
    });
    return c.json({ ok: true });
  });

  // ── Email templates (plan 003 phase 3): list / get-effective / override / reset ──────────
  // Each known key always resolves (admin override else seeded default), so the editor can
  // show + edit every template even before any override exists.
  app.get("/email-templates", async (c) => {
    const overrides = new Map((await deps.emailTemplates.list()).map((t) => [t.key, t]));
    const templates = TEMPLATE_KEYS.map((key) => {
      const row = overrides.get(key);
      const body = row ?? DEFAULT_TEMPLATES[key];
      // A boot-seeded default row has `updatedBy = null`; only an ADMIN override sets it. So
      // a present row alone is NOT "overridden" — the boot seed inserts one for every key, so
      // `!!row` would read as customized everywhere in production. Key off the updater.
      return {
        key,
        subject: body.subject,
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyText,
        overridden: row?.updatedBy != null,
      };
    });
    return c.json({ templates });
  });

  app.put("/email-templates/:key", sameOrigin, async (c) => {
    const key = c.req.param("key");
    if (!TEMPLATE_KEYS.includes(key as (typeof TEMPLATE_KEYS)[number])) {
      return c.json({ error: "not_found" }, 404);
    }
    const body = templateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    await deps.emailTemplates.upsert(key, body.data, c.get("user").id);
    deps.audit.recordAudit({
      action: "admin_settings_update",
      actorId: c.get("user").id,
      meta: { keys: [`email_template.${key}`] },
    });
    return c.json({ ok: true });
  });

  // Reset a template to its seeded default (delete the override row).
  app.delete("/email-templates/:key", sameOrigin, async (c) => {
    const key = c.req.param("key");
    if (!TEMPLATE_KEYS.includes(key as (typeof TEMPLATE_KEYS)[number])) {
      return c.json({ error: "not_found" }, 404);
    }
    await deps.emailTemplates.remove(key);
    deps.audit.recordAudit({
      action: "admin_settings_update",
      actorId: c.get("user").id,
      meta: { keys: [`email_template.${key}`, "reset"] },
    });
    return c.json({ ok: true });
  });

  return app;
}

/** Load any canvas by id (admin sees every status); null when missing. */
async function loadCanvas(deps: AdminRoutesDeps, id: string | undefined): Promise<Canvas | null> {
  if (!id) return null;
  return deps.canvases.findById(id);
}

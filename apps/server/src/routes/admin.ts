import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { z } from "zod";
import { requireAdmin } from "../admin/authz.js";
import { type AdminSettingsService, QUOTA_KEYS, type QuotaKey } from "../admin/settings-service.js";
import type { AuditLog } from "../audit/audit-log.js";
import { MAX_CANVAS_BYTES, MAX_FILE_BYTES } from "../canvas/files-service.js";
import { canvasUrl } from "../canvas/url.js";
import type { AdminCanvasStatus, AdminRepository } from "../db/repositories/admin.js";
import type { AiUsageRepository } from "../db/repositories/ai-usage.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { requireSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
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
  audit: AuditLog;
}

const STATUSES = ["active", "disabled", "archived", "deleted"] as const;
const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(), // UUIDv7 id keyset cursor
});
const disableBody = z.object({ reason: z.string().trim().min(1).max(500) });
const modelsBody = z.object({ models: z.array(z.string().min(1)).min(1) });
const quotasBody = z.object({
  quotas: z.record(z.string(), z.number().finite().positive()),
});
// A config override value: string | number | boolean | string[] (per the field's
// type — the settings service validates/coerces against the registry).
const configBody = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
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

  app.use("*", requireAdmin());

  // --- All-canvases list (§6.10.1): owner / status / size / usage / last-activity ---
  app.get("/canvases", async (c) => {
    const q = listQuery.safeParse({
      status: c.req.query("status"),
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    if (!q.success) return c.json({ error: "invalid_query" }, 400);

    const rows = await deps.admin.listAllCanvases({
      status: q.data.status as AdminCanvasStatus | undefined,
      limit: q.data.limit,
      cursor: q.data.cursor,
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
        disabledReason: cv.disabledReason,
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
    // Keyset cursor is the last row's id (unique + time-ordered); null = last page.
    const nextCursor = rows.length === q.data.limit ? (rows.at(-1)?.id ?? null) : null;
    return c.json({ canvases, nextCursor });
  });

  // --- Platform usage overview (§6.10.6): totals + top canvases + AI spend ---
  app.get("/overview", async (c) => {
    const [stats, ai] = await Promise.all([deps.admin.platformStats(10), deps.aiUsage.platformSpend()]);
    // Enrich the top canvases with slug/title (small N — direct lookups).
    const top = await Promise.all(
      stats.topCanvases.map(async (t) => {
        const cv = await deps.canvases.findById(t.canvasId);
        return {
          canvasId: t.canvasId,
          ops: t.ops,
          slug: cv?.slug ?? null,
          title: cv?.title ?? null,
        };
      }),
    );
    return c.json({
      canvasCountByStatus: stats.canvasCountByStatus,
      userCount: stats.userCount,
      totalFileBytes: stats.totalFileBytes,
      totalOps: stats.totalOps,
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

  // --- AI usage breakdown (§6.10.7): top spenders by user and by canvas ---
  app.get("/ai-usage", async (c) => {
    const [byUserRaw, byCanvasRaw] = await Promise.all([
      deps.aiUsage.spendByUser(10),
      deps.aiUsage.spendByCanvas(10),
    ]);
    // Enrich ids → email / slug+title. Batch the user lookup (one query), and do
    // small-N direct canvas lookups (top-10) like the overview's top-canvases.
    const users = await deps.users.findByIds(byUserRaw.map((r) => r.id));
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    const byUser = byUserRaw.map((r) => ({
      userId: r.id,
      email: emailById.get(r.id) ?? null,
      costUsd: r.costUsd,
      calls: r.calls,
    }));
    const byCanvas = await Promise.all(
      byCanvasRaw.map(async (r) => {
        const cv = await deps.canvases.findById(r.id);
        return {
          canvasId: r.id,
          slug: cv?.slug ?? null,
          title: cv?.title ?? null,
          costUsd: r.costUsd,
          calls: r.calls,
        };
      }),
    );
    return c.json({ byUser, byCanvas });
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

  return app;
}

/** Load any canvas by id (admin sees every status); null when missing. */
async function loadCanvas(deps: AdminRoutesDeps, id: string | undefined): Promise<Canvas | null> {
  if (!id) return null;
  return deps.canvases.findById(id);
}

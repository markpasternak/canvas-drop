import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { adminSettingsService } from "../admin/settings-service.js";
import { createAuditLog } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { adminRepository } from "../db/repositories/admin.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { filesRepository } from "../db/repositories/files.js";
import { settingsRepository } from "../db/repositories/settings.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { adminRoutes } from "./admin.js";

const silent = pino({ level: "silent" });
const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

function buildAdminApp(client: DbClient, actor: { id: string; isAdmin: boolean }) {
  const canvases = canvasesRepository(client);
  const audit = createAuditLog(auditRepository(client), silent);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: actor.id, isAdmin: actor.isAdmin } as never);
    c.set("clientIp", "127.0.0.1");
    await next();
  });
  app.route(
    "/api/admin",
    adminRoutes({
      config,
      admin: adminRepository(client),
      canvases,
      versions: versionsRepository(client),
      users: usersRepository(client),
      files: filesRepository(client),
      aiUsage: aiUsageRepository(client),
      settings: adminSettingsService({ settings: settingsRepository(client), config }),
      audit,
    }),
  );
  return { app, audit, canvases };
}

async function seedUser(client: DbClient, sub: string) {
  return usersRepository(client).upsert({
    providerSub: sub,
    email: `${sub}@example.com`,
    name: sub,
    isAdmin: false,
  });
}

const post = (body?: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});
const put = (body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("admin routes", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("404s EVERY admin route for a non-admin (no existence leak)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "alice");
    const { app, canvases } = buildAdminApp(client, { id: owner.id, isAdmin: false });
    const cv = await canvases.create({ ownerId: owner.id, slug: "x-1111-2222", apiKeyHash: "h" });
    for (const [method, path] of [
      ["GET", "/api/admin/canvases"],
      ["GET", "/api/admin/overview"],
      ["GET", "/api/admin/ai-usage"],
      ["GET", "/api/admin/settings/models"],
      ["GET", "/api/admin/settings/quotas"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(404);
    }
    const dis = await app.request(`/api/admin/canvases/${cv.id}/disable`, post({ reason: "x" }));
    expect(dis.status).toBe(404);
  });

  it("admin disables a canvas with a reason (audited); enable clears it", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "alice");
    const admin = await usersRepository(client).upsert({
      providerSub: "admin",
      email: "admin@example.com",
      name: "admin",
      isAdmin: true,
    });
    const { app, audit, canvases } = buildAdminApp(client, { id: admin.id, isAdmin: true });
    const cv = await canvases.create({ ownerId: owner.id, slug: "x-1111-2222", apiKeyHash: "h" });

    const dis = await app.request(
      `/api/admin/canvases/${cv.id}/disable`,
      post({ reason: "policy violation" }),
    );
    expect(dis.status).toBe(200);
    const down = await canvases.findById(cv.id);
    expect(down?.status).toBe("disabled");
    expect(down?.disabledReason).toBe("policy violation");
    await audit.flush();
    const rows = (await auditRepository(client).recent(50)) as Array<{
      action: string;
      meta: { reason?: string } | null;
    }>;
    const disableRow = rows.find((r) => r.action === "canvas_disable");
    expect(disableRow).toBeDefined();
    expect(disableRow?.meta?.reason).toBe("policy violation");

    const en = await app.request(`/api/admin/canvases/${cv.id}/enable`, post());
    expect(en.status).toBe(200);
    const up = await canvases.findById(cv.id);
    expect(up?.status).toBe("active");
    expect(up?.disabledReason).toBeNull();
  });

  it("disable on an archived canvas → 409 not_active", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "alice");
    const { app, canvases } = buildAdminApp(client, { id: "admin", isAdmin: true });
    const cv = await canvases.create({ ownerId: owner.id, slug: "x-1111-2222", apiKeyHash: "h" });
    await canvases.archive(cv.id);
    const res = await app.request(`/api/admin/canvases/${cv.id}/disable`, post({ reason: "x" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_active");
  });

  it("restores a soft-deleted canvas; 409 on a non-deleted one", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "alice");
    const { app, canvases } = buildAdminApp(client, { id: "admin", isAdmin: true });
    const cv = await canvases.create({ ownerId: owner.id, slug: "x-1111-2222", apiKeyHash: "h" });
    await canvases.setStatus(cv.id, "deleted");
    expect((await app.request(`/api/admin/canvases/${cv.id}/restore`, post())).status).toBe(200);
    expect((await canvases.findById(cv.id))?.status).toBe("active");
    // already active → 409
    expect((await app.request(`/api/admin/canvases/${cv.id}/restore`, post())).status).toBe(409);
  });

  it("lists canvases across owners with status filter + enrichment", async () => {
    client = await makeTestDb("sqlite");
    const a = await seedUser(client, "alice");
    const b = await seedUser(client, "bob");
    const { app, canvases } = buildAdminApp(client, { id: "admin", isAdmin: true });
    await canvases.create({ ownerId: a.id, slug: "aa-1111-2222", apiKeyHash: "h1" });
    const c2 = await canvases.create({ ownerId: b.id, slug: "bb-1111-2222", apiKeyHash: "h2" });
    await canvases.setDisabled(c2.id, "spam");

    const all = await app.request("/api/admin/canvases");
    expect(all.status).toBe(200);
    const body = (await all.json()) as {
      canvases: Array<{ owner: { email: string }; disabledReason: string | null }>;
    };
    expect(body.canvases.length).toBe(2);
    const owners = new Set(body.canvases.map((c) => c.owner.email));
    expect(owners).toEqual(new Set(["alice@example.com", "bob@example.com"]));

    const disabled = (await (await app.request("/api/admin/canvases?status=disabled")).json()) as {
      canvases: Array<{ disabledReason: string | null; deletedAt: number | null }>;
    };
    expect(disabled.canvases.length).toBe(1);
    expect(disabled.canvases[0]?.disabledReason).toBe("spam");
    // deletedAt is surfaced per row (null unless soft-deleted) for the purge-age hint.
    expect(disabled.canvases[0]?.deletedAt).toBeNull();
  });

  it("overview returns totals + top canvases + AI spend", async () => {
    client = await makeTestDb("sqlite");
    const a = await seedUser(client, "alice");
    const { app, canvases } = buildAdminApp(client, { id: "admin", isAdmin: true });
    const cv = await canvases.create({ ownerId: a.id, slug: "aa-1111-2222", apiKeyHash: "h1" });
    await aiUsageRepository(client).record({
      canvasId: cv.id,
      userId: a.id,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0125,
    });
    const res = await app.request("/api/admin/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      canvasCountByStatus: Record<string, number>;
      userCount: number;
      totalOps: number;
      newCanvases: number;
      newUsers: number;
      recentWindowDays: number;
      oldestDeletedAt: number | null;
      topCanvases: unknown[];
      aiCostUsd: number;
      aiTokens: number;
      aiCalls: number;
    };
    expect(body.canvasCountByStatus.active).toBe(1);
    expect(body.userCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.topCanvases)).toBe(true);
    // Expanded overview fields (§6.10.6).
    expect(body.totalOps).toBe(0);
    expect(body.newCanvases).toBe(1); // just created → inside the window
    expect(body.recentWindowDays).toBe(7);
    expect(body.oldestDeletedAt).toBeNull();
    // AI spend (§6.10.6) — no longer the "deferred to M9" stub.
    expect(body.aiCostUsd).toBeCloseTo(0.0125, 10);
    expect(body.aiTokens).toBe(150);
    expect(body.aiCalls).toBe(1);
  });

  it("overview reports zeroed AI spend when there is no AI usage", async () => {
    client = await makeTestDb("sqlite");
    const { app } = buildAdminApp(client, { id: "admin", isAdmin: true });
    const body = (await (await app.request("/api/admin/overview")).json()) as {
      aiCostUsd: number;
      aiTokens: number;
      aiCalls: number;
    };
    expect(body).toMatchObject({ aiCostUsd: 0, aiTokens: 0, aiCalls: 0 });
  });

  it("ai-usage returns by-user (email) and by-canvas (slug/title) spend, ordered desc", async () => {
    client = await makeTestDb("sqlite");
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    const { app, canvases } = buildAdminApp(client, { id: "admin", isAdmin: true });
    const ca = await canvases.create({ ownerId: alice.id, slug: "ca-1111-2222", apiKeyHash: "ha" });
    const cb = await canvases.create({ ownerId: bob.id, slug: "cb-1111-2222", apiKeyHash: "hb" });
    const ai = aiUsageRepository(client);
    const rec = (canvasId: string, userId: string, costUsd: number) =>
      ai.record({
        canvasId,
        userId,
        provider: "anthropic",
        model: "claude-haiku-4-5",
        inputTokens: 10,
        outputTokens: 5,
        costUsd,
      });
    // bob outspends alice; canvas cb outspends ca.
    await rec(ca.id, alice.id, 1.0);
    await rec(cb.id, bob.id, 4.0);

    const res = await app.request("/api/admin/ai-usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      byUser: Array<{ userId: string; email: string | null; costUsd: number; calls: number }>;
      byCanvas: Array<{ canvasId: string; slug: string | null; title: string | null; costUsd: number }>;
    };
    expect(body.byUser.map((u) => u.email)).toEqual(["bob@example.com", "alice@example.com"]);
    expect(body.byUser[0].costUsd).toBeCloseTo(4.0, 10);
    expect(body.byCanvas.map((c2) => c2.slug)).toEqual(["cb-1111-2222", "ca-1111-2222"]);
    expect(body.byCanvas[0].costUsd).toBeCloseTo(4.0, 10);
  });

  it("ai-usage returns empty breakdowns (not null) when there is no AI usage", async () => {
    client = await makeTestDb("sqlite");
    const { app } = buildAdminApp(client, { id: "admin", isAdmin: true });
    const body = (await (await app.request("/api/admin/ai-usage")).json()) as {
      byUser: unknown[];
      byCanvas: unknown[];
    };
    expect(body).toEqual({ byUser: [], byCanvas: [] });
  });

  it("manages the model allowlist + quota defaults (audited); rejects invalid bodies", async () => {
    client = await makeTestDb("sqlite");
    const { app } = buildAdminApp(client, { id: "admin", isAdmin: true });

    const models1 = (await (await app.request("/api/admin/settings/models")).json()) as {
      models: string[];
    };
    expect(models1.models).toEqual(config.ai.models);
    const setModels = await app.request(
      "/api/admin/settings/models",
      put({ models: ["m1", "m2"] }),
    );
    expect(setModels.status).toBe(200);
    const models2 = (await (await app.request("/api/admin/settings/models")).json()) as {
      models: string[];
    };
    expect(models2.models).toEqual(["m1", "m2"]);
    expect((await app.request("/api/admin/settings/models", put({ models: [] }))).status).toBe(400);

    const setQuota = await app.request(
      "/api/admin/settings/quotas",
      put({ quotas: { "kv.keys.shared": 42 } }),
    );
    expect(setQuota.status).toBe(200);
    const quotaBody = (await (await app.request("/api/admin/settings/quotas")).json()) as {
      quotas: Array<{ key: string; value: number; override: number | null }>;
    };
    const shared = quotaBody.quotas.find((q) => q.key === "kv.keys.shared");
    expect(shared?.value).toBe(42);
    expect(shared?.override).toBe(42);
    // Unknown key rejected.
    expect(
      (await app.request("/api/admin/settings/quotas", put({ quotas: { bogus: 1 } }))).status,
    ).toBe(400);
  });

  it("rejects a cross-site mutation (same-origin guard)", async () => {
    client = await makeTestDb("sqlite");
    const { app } = buildAdminApp(client, { id: "admin", isAdmin: true });
    const res = await app.request("/api/admin/settings/models", {
      method: "PUT",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ models: ["m1"] }),
    });
    expect(res.status).toBe(403);
  });

  it("GET /config returns every setting; secrets never carry a raw value", async () => {
    client = await makeTestDb("sqlite");
    const { app } = buildAdminApp(client, { id: "admin", isAdmin: true });
    const body = (await (await app.request("/api/admin/config")).json()) as {
      fields: Array<{
        key: string;
        secret: boolean;
        editable: boolean;
        value?: string;
        set?: boolean;
      }>;
    };
    const key = body.fields.find((f) => f.key === "ai.apiKey");
    expect(key?.secret).toBe(true);
    expect(key).not.toHaveProperty("value"); // a secret must never serialize its value
    // The model allowlist is a non-secret editable field with a value.
    const models = body.fields.find((f) => f.key === "ai.models");
    expect(models?.editable).toBe(true);
    expect(typeof models?.value).toBe("string");
  });

  it("PUT/DELETE /config sets then clears an editable override; read-only is rejected", async () => {
    client = await makeTestDb("sqlite");
    const { app } = buildAdminApp(client, { id: "admin", isAdmin: true });
    const fieldFor = async (k: string) => {
      const r = (await (await app.request("/api/admin/config")).json()) as {
        fields: Array<{ key: string; source: string; overridden: boolean; value?: string }>;
      };
      return r.fields.find((f) => f.key === k);
    };

    const set = await app.request("/api/admin/config/ai.models", put({ value: ["m1", "m2"] }));
    expect(set.status).toBe(200);
    const after = await fieldFor("ai.models");
    expect(after?.source).toBe("database");
    expect(after?.value).toBe("m1, m2");

    const cleared = await app.request("/api/admin/config/ai.models", { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect((await fieldFor("ai.models"))?.overridden).toBe(false);

    // A read-only field cannot be overridden via the API.
    expect((await app.request("/api/admin/config/auth.mode", put({ value: "oidc" }))).status).toBe(
      400,
    );
    // An invalid value (non-positive quota) is rejected.
    expect(
      (await app.request("/api/admin/config/quota.ai.user.daily.usd", put({ value: 0 }))).status,
    ).toBe(400);
  });

  it("setting the AI provider key never echoes it back; status shows source+last4 only", async () => {
    client = await makeTestDb("sqlite");
    const { app } = buildAdminApp(client, { id: "admin", isAdmin: true });
    const res = await app.request(
      "/api/admin/config/ai.apiKey",
      put({ value: "sk-ant-secret-WXYZ" }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("sk-ant-secret-WXYZ");
    const r = (await (await app.request("/api/admin/config")).json()) as {
      fields: Array<{ key: string; set?: boolean; last4?: string; source: string }>;
    };
    const key = r.fields.find((f) => f.key === "ai.apiKey");
    expect(key).toMatchObject({ set: true, last4: "WXYZ", source: "database" });
    expect(JSON.stringify(r)).not.toContain("sk-ant-secret-WXYZ");
  });
});

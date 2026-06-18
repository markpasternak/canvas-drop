import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "../ai/provider.js";
import { fakeProvider } from "../ai/testing.js";
import type { DbClient } from "../db/factory.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { canvasApiRoutes } from "./canvas-api.js";

const aiConfig: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_AI_API_KEY: "test-key",
  CANVAS_DROP_AI_MODELS: "claude-haiku-4-5,claude-sonnet-4-6",
  CANVAS_DROP_AI_USER_DAILY_USD: "5",
  CANVAS_DROP_AI_CANVAS_MONTHLY_USD: "50",
});
const noKeyConfig: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

async function seedUser(client: DbClient) {
  return usersRepository(client).upsert({
    providerSub: "owner",
    email: "owner@example.com",
    name: "Owner",
    isAdmin: false,
  });
}

function buildApi(client: DbClient, userId: string, provider: ModelProvider, config = aiConfig) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: userId,
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
      isAdmin: false,
    } as never);
    await next();
  });
  app.route(
    "/v1/c/:slug",
    canvasApiRoutes({
      config,
      canvases: canvasesRepository(client),
      // KV/files unused here; pass the real AI repo and the injected provider.
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      kv: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      files: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      usage: {} as any,
      aiUsage: aiUsageRepository(client),
      aiProvider: provider,
    }),
  );
  return app;
}

/** Build the API with a `settings` stub so the DB-effective config path runs
 *  (effective key/models/quota), mirroring production wiring. */
function buildApiWithSettings(
  client: DbClient,
  userId: string,
  provider: ModelProvider,
  settings: {
    effectiveModels: () => Promise<string[]>;
    effectiveApiKey: () => Promise<string | undefined>;
    aiEnabled: () => Promise<boolean>;
    effectiveQuota: (key: string, fallback: number) => Promise<number>;
  },
  config = aiConfig,
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: userId,
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
      isAdmin: false,
    } as never);
    await next();
  });
  app.route(
    "/v1/c/:slug",
    canvasApiRoutes({
      config,
      canvases: canvasesRepository(client),
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      kv: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      files: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      usage: {} as any,
      aiUsage: aiUsageRepository(client),
      aiProvider: provider,
      // biome-ignore lint/suspicious/noExplicitAny: narrow settings stub for this suite
      settings: settings as any,
    }),
  );
  return app;
}

/** Build the API with a GUEST principal so the guest-AI gate branches run. The
 *  guest still carries a `user` row (the resolved guest identity) for metering. */
function buildGuestApi(
  client: DbClient,
  guestEmail: string,
  canvasId: string,
  provider: ModelProvider,
  config = aiConfig,
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    // A complete guest principal (id/inviteId/canvasId/email) so requestPrincipal
    // resolves a guest and the specific_people access check matches by email.
    c.set("principal", {
      kind: "guest",
      id: `guest:${guestEmail}`,
      inviteId: "inv1",
      canvasId,
      email: guestEmail,
    } as never);
    await next();
  });
  app.route(
    "/v1/c/:slug",
    canvasApiRoutes({
      config,
      canvases: canvasesRepository(client),
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      kv: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      files: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      usage: {} as any,
      aiUsage: aiUsageRepository(client),
      aiProvider: provider,
    }),
  );
  return app;
}

/** Parse an SSE body into the list of decoded `data:` JSON objects. */
function parseSSE(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice("data:".length).trim()));
}

async function makeCanvas(
  client: DbClient,
  opts: { backendEnabled?: boolean; capAi?: boolean } = {},
) {
  const owner = await seedUser(client);
  const cv = await canvasesRepository(client).create({
    ownerId: owner.id,
    slug: "app",
    apiKeyHash: "h-app",
    backendEnabled: opts.backendEnabled ?? true,
  });
  if (opts.capAi === false) {
    await canvasesRepository(client).updateCapabilities(cv.id, { ai: false });
  }
  return { owner, cv };
}

const post = (app: Hono<AppEnv>, body: unknown, init: RequestInit = {}) =>
  app.request("/v1/c/app/ai/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

describe("canvasAiRoutes (POST /ai/chat)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("streams deltas then a done frame with usage + cost, and records ai_usage", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeCanvas(client);
    const provider = fakeProvider({
      deltas: ["Hello", " world"],
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const res = await post(buildApi(client, owner.id, provider), {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSSE(await res.text());
    expect(events.filter((e) => e.type === "delta").map((e) => e.text)).toEqual([
      "Hello",
      " world",
    ]);
    const done = events.find((e) => e.type === "done") as
      | { usage: { inputTokens: number; outputTokens: number }; cost: number }
      | undefined;
    expect(done?.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    // haiku: 10/1e6*1 + 20/1e6*5 = 0.00011
    expect(done?.cost).toBeCloseTo(0.00011, 8);

    // metering row written against the SERVER-resolved user/canvas (§12.0 #2)
    const spend = await aiUsageRepository(client).userSpendSince(owner.id, 0);
    expect(spend).toBeCloseTo(0.00011, 8);
  });

  it("rejects a model not in the admin allowlist (403 MODEL_NOT_ALLOWED)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeCanvas(client);
    const res = await post(buildApi(client, owner.id, fakeProvider({ deltas: ["x"] })), {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("MODEL_NOT_ALLOWED");
  });

  it("rejects an allowlisted-but-unpriced model (fail closed to protect the spend quota)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeCanvas(client);
    // Allowlist a model with no pricing entry — it must NOT be served (cost would
    // be $0 and the quota would never trip → unbounded spend).
    const cfg = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_AI_API_KEY: "test-key",
      CANVAS_DROP_AI_MODELS: "made-up-model-v9",
    });
    const res = await post(buildApi(client, owner.id, fakeProvider({ deltas: ["x"] }), cfg), {
      model: "made-up-model-v9",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("MODEL_NOT_ALLOWED");
  });

  it("rejects when the per-canvas monthly quota is already met (429 scope canvas_monthly)", async () => {
    client = await makeTestDb("sqlite");
    const { owner, cv } = await makeCanvas(client);
    // Seed canvas spend to the monthly limit under a DIFFERENT user so the daily
    // (per-user) window stays clear and the monthly (per-canvas) window trips.
    const other = await usersRepository(client).upsert({
      providerSub: "other",
      email: "other@example.com",
      name: "Other",
      isAdmin: false,
    });
    await aiUsageRepository(client).record({
      canvasId: cv.id,
      userId: other.id,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 50, // exactly the canvas monthly limit
    });
    const res = await post(buildApi(client, owner.id, fakeProvider({ deltas: ["x"] })), {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; scope: string };
    expect(body.code).toBe("QUOTA_EXCEEDED");
    expect(body.scope).toBe("canvas_monthly");
  });

  it("rejects when the per-user daily quota is already met (429 QUOTA_EXCEEDED)", async () => {
    client = await makeTestDb("sqlite");
    const { owner, cv } = await makeCanvas(client);
    await aiUsageRepository(client).record({
      canvasId: cv.id,
      userId: owner.id,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 5, // exactly the daily limit
    });
    const res = await post(buildApi(client, owner.id, fakeProvider({ deltas: ["x"] })), {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; scope: string };
    expect(body.code).toBe("QUOTA_EXCEEDED");
    expect(body.scope).toBe("user_daily");
  });

  it("enforces the admin-overridden (DB) AI USD daily quota, not the env config value", async () => {
    client = await makeTestDb("sqlite");
    const { owner, cv } = await makeCanvas(client);
    // Spend $1 — under the env cap ($5) but at the admin-lowered override ($1).
    await aiUsageRepository(client).record({
      canvasId: cv.id,
      userId: owner.id,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 1,
    });
    const settings = {
      effectiveModels: async () => ["claude-haiku-4-5"],
      effectiveApiKey: async () => "test-key",
      aiEnabled: async () => true,
      // Admin lowered the per-user daily cap to $1; everything else uses the fallback.
      effectiveQuota: async (key: string, fallback: number) =>
        key === "ai.user.daily.usd" ? 1 : fallback,
    };
    const res = await post(
      buildApiWithSettings(client, owner.id, fakeProvider({ deltas: ["x"] }), settings),
      { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] },
    );
    // The env cap ($5) would allow this; the DB override ($1) blocks it.
    expect(res.status).toBe(429);
    expect(((await res.json()) as { scope: string }).scope).toBe("user_daily");
  });

  it("a DB-set key flips the capability gate from 403 to allowed with NO env key (no restart)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeCanvas(client);
    const settings = {
      effectiveModels: async () => ["claude-haiku-4-5"],
      effectiveApiKey: async () => "db-set-key",
      aiEnabled: async () => true, // admin set the key in the DB; env has none
      effectiveQuota: async (_key: string, fallback: number) => fallback,
    };
    const res = await post(
      // noKeyConfig: env has NO provider key — only the DB key (via settings) enables AI.
      buildApiWithSettings(
        client,
        owner.id,
        fakeProvider({ deltas: ["ok"] }),
        settings,
        noKeyConfig,
      ),
      { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.status).toBe(200); // gate passed on the DB-effective key, not config
  });

  it("403 CAPABILITY_DISABLED when backend is off", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeCanvas(client, { backendEnabled: false });
    const res = await post(buildApi(client, owner.id, fakeProvider({ deltas: ["x"] })), {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("CAPABILITY_DISABLED");
  });

  it("403 CAPABILITY_DISABLED when cap_ai is off", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeCanvas(client, { capAi: false });
    const res = await post(buildApi(client, owner.id, fakeProvider({ deltas: ["x"] })), {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(403);
  });

  it("403 CAPABILITY_DISABLED when no provider key is configured (empty key too)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeCanvas(client);
    const res = await post(
      buildApi(client, owner.id, fakeProvider({ deltas: ["x"] }), noKeyConfig),
      { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.status).toBe(403);
  });

  it("emits an error frame on upstream failure (no provider internals leaked)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeCanvas(client);
    const provider = fakeProvider({ deltas: ["a", "b"], throwAfter: 1 });
    const res = await post(buildApi(client, owner.id, provider), {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    const events = parseSSE(await res.text());
    const err = events.find((e) => e.type === "error") as { code: string; message: string };
    expect(err.code).toBe("AI_UPSTREAM_ERROR");
    expect(err.message).not.toContain("boom"); // upstream details not leaked
  });

  it("rejects an invalid body (400 INVALID_BODY)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeCanvas(client);
    const res = await post(buildApi(client, owner.id, fakeProvider({ deltas: ["x"] })), {
      model: "claude-haiku-4-5",
      messages: [], // empty → invalid
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_BODY");
  });

  /** Make a specific_people canvas with the given guest email on the allowlist so a
   *  guest principal passes the access gate and reaches the guest-AI branch. */
  async function makeGuestCanvas(opts: { guestAiEnabled: boolean; guestAiCap?: number }) {
    const guestEmail = "guest@example.com";
    const { cv } = await makeCanvas(client);
    const repo = canvasesRepository(client);
    await repo.setAccess(cv.id, "specific_people");
    await repo.addAllowlistEntry({ canvasId: cv.id, principalKind: "guest", email: guestEmail });
    await repo.updateSettings(cv.id, {
      guestAiEnabled: opts.guestAiEnabled,
      ...(opts.guestAiCap !== undefined ? { guestAiCap: opts.guestAiCap } : {}),
    });
    return { cv, guestEmail };
  }

  it("403 GUEST_AI_DISABLED when a guest calls and the owner has not opted the canvas in", async () => {
    client = await makeTestDb("sqlite");
    const { cv, guestEmail } = await makeGuestCanvas({ guestAiEnabled: false });
    const res = await post(
      buildGuestApi(client, guestEmail, cv.id, fakeProvider({ deltas: ["x"] })),
      { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("GUEST_AI_DISABLED");
  });

  it("429 GUEST_AI_CAP when guest AI is on but the canvas monthly spend meets the cap", async () => {
    client = await makeTestDb("sqlite");
    const { cv, guestEmail } = await makeGuestCanvas({ guestAiEnabled: true, guestAiCap: 1 });
    // Seed canvas monthly spend at the guest cap so the guest call trips it.
    await aiUsageRepository(client).record({
      canvasId: cv.id,
      userId: cv.ownerId,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 1, // exactly the guest cap
    });
    const res = await post(
      buildGuestApi(client, guestEmail, cv.id, fakeProvider({ deltas: ["x"] })),
      { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] },
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; scope: string };
    expect(body.code).toBe("GUEST_AI_CAP");
    expect(body.scope).toBe("guest");
  });

  it("records usage even when the client aborts before streaming (no quota leak)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeCanvas(client);
    const ac = new AbortController();
    ac.abort(); // already-aborted request signal
    const provider = fakeProvider({
      deltas: ["a", "b", "c"],
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    await Promise.resolve(
      post(
        buildApi(client, owner.id, provider),
        {
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: "hi" }],
        },
        { signal: ac.signal },
      ),
    ).catch(() => {});
    // usage was still recorded against the quota despite the abort
    const spend = await aiUsageRepository(client).userSpendSince(owner.id, 0);
    // haiku: 4/1e6*1 + 2/1e6*5 = 0.000014
    expect(spend).toBeCloseTo(0.000014, 9);
  });
});

import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { filesService } from "../canvas/files-service.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { filesRepository } from "../db/repositories/files.js";
import { kvRepository } from "../db/repositories/kv.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { canvasApiRoutes } from "./canvas-api.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

function buildApi(client: DbClient, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: userId,
      email: `${userId}@x.com`,
      name: userId,
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
      kv: kvRepository(client),
      files: filesService({ files: filesRepository(client), storage: memStorage() }),
      usage: usageEventsRepository(client),
    }),
  );
  return app;
}

async function setup(client: DbClient, backendEnabled = true, capKv = true) {
  const owner = await usersRepository(client).upsert({
    providerSub: "owner",
    email: "o@x.com",
    name: "o",
    isAdmin: false,
  });
  const cv = await canvasesRepository(client).create({
    ownerId: owner.id,
    slug: "app",
    apiKeyHash: "h",
    backendEnabled,
  });
  // Shared so non-owner viewers can use the runtime API (kv.user is per-viewer).
  await canvasesRepository(client).updateSettings(cv.id, { shared: true });
  if (!capKv) await canvasesRepository(client).updateCapabilities(cv.id, { kv: false });
  return { ownerId: owner.id, canvasId: cv.id };
}

const json = (body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("canvas KV routes", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("set/get/delete round-trip (shared scope) + meters kv_op", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId, canvasId } = await setup(client);
    const app = buildApi(client, ownerId);
    expect((await app.request("/v1/c/app/kv/greeting", json({ hi: 1 }))).status).toBe(200);
    const got = await app.request("/v1/c/app/kv/greeting");
    expect(await got.json()).toEqual({ value: { hi: 1 } });
    expect((await app.request("/v1/c/app/kv/greeting", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/v1/c/app/kv/greeting")).status).toBe(404);
    expect((await usageEventsRepository(client).countByType(canvasId, null)).kv_op).toBeGreaterThan(
      0,
    );
  });

  it("list filters by prefix and paginates", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client);
    const app = buildApi(client, ownerId);
    for (const k of ["a:1", "a:2", "b:1"]) await app.request(`/v1/c/app/kv/${k}`, json(0));
    const res = await app.request("/v1/c/app/kv?prefix=a:&limit=1");
    const body = (await res.json()) as { entries: { key: string }[]; nextCursor: string | null };
    expect(body.entries.map((e) => e.key)).toEqual(["a:1"]);
    expect(body.nextCursor).toBe("a:1");
  });

  it("increment returns the running total", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client);
    const app = buildApi(client, ownerId);
    const r1 = await app.request("/v1/c/app/kv/votes/increment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ by: 2 }),
    });
    expect(await r1.json()).toEqual({ value: 2 });
    const r2 = await app.request("/v1/c/app/kv/votes/increment", { method: "POST" });
    expect(await r2.json()).toEqual({ value: 3 });
  });

  it("kv/user/* is scoped per viewer (one user can't read another's)", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client);
    const other = await usersRepository(client).upsert({
      providerSub: "other",
      email: "other@x.com",
      name: "other",
      isAdmin: false,
    });
    await buildApi(client, ownerId).request("/v1/c/app/kv/user/pref", json("owner-val"));
    await buildApi(client, other.id).request("/v1/c/app/kv/user/pref", json("other-val"));
    expect(
      await (await buildApi(client, ownerId).request("/v1/c/app/kv/user/pref")).json(),
    ).toEqual({
      value: "owner-val",
    });
    expect(
      await (await buildApi(client, other.id).request("/v1/c/app/kv/user/pref")).json(),
    ).toEqual({
      value: "other-val",
    });
  });

  it("rejects an oversized value (413) and oversized key (413)", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client);
    const app = buildApi(client, ownerId);
    const big = "x".repeat(65 * 1024);
    expect((await app.request("/v1/c/app/kv/k", json(big))).status).toBe(413);
    const longKey = "k".repeat(600);
    expect((await app.request(`/v1/c/app/kv/${longKey}`, json(1))).status).toBe(413);
  });

  it("403s when the kv capability is off", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client, true, false); // backend on, kv off
    const app = buildApi(client, ownerId);
    const res = await app.request("/v1/c/app/kv/k", json(1));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("CAPABILITY_DISABLED");
  });

  it("403s when backend is off entirely", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client, false);
    const app = buildApi(client, ownerId);
    expect((await app.request("/v1/c/app/kv/k")).status).toBe(403);
  });

  it("keys are isolated across canvases", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client);
    await canvasesRepository(client).create({
      ownerId,
      slug: "other",
      apiKeyHash: "h2",
      backendEnabled: true,
    });
    const app = buildApi(client, ownerId);
    await app.request("/v1/c/app/kv/secret", json("A"));
    expect((await app.request("/v1/c/other/kv/secret")).status).toBe(404);
  });
});

import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import { verifyPassword } from "../canvas/password.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { managementRoutes } from "./management.js";

const silent = pino({ level: "silent" });
const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Build a management app that authenticates as a chosen user (no gateway needed). */
function buildApp(client: DbClient, actor: { id: string; isAdmin: boolean }) {
  const canvases = canvasesRepository(client);
  const audit = createAuditLog(auditRepository(client), silent);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    // stand in for the foundation gateway: inject the authenticated user
    c.set("user", { id: actor.id, isAdmin: actor.isAdmin } as never);
    c.set("clientIp", "127.0.0.1");
    await next();
  });
  app.route("/api/canvases", managementRoutes({ config, canvases, audit }));
  return app;
}

async function seedUser(client: DbClient, sub: string, isAdmin = false) {
  return usersRepository(client).upsert({
    providerSub: sub,
    email: `${sub}@example.com`,
    name: sub,
    isAdmin,
  });
}

describe("managementRoutes", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("create returns a unique slug + cd_ key once, storing only the hash", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const res = await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ title: "My Canvas" }),
    });
    expect(res.status).toBe(201);
    const body = await jsonOf<{ id: string; slug: string; url: string; apiKey: string }>(res);
    expect(body.slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{13}$/);
    expect(body.apiKey).toMatch(/^cd_/);
    expect(body.url).toContain(body.slug);
    // the stored hash is not the raw key
    const cv = await canvasesRepository(client).findById(body.id);
    expect(cv?.apiKeyHash).not.toBe(body.apiKey);
  });

  it("GET /:id returns the canvas to its owner, 404 to a different user", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const created = await jsonOf<{ id: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const asOwner = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      `/api/canvases/${created.id}`,
    );
    expect(asOwner.status).toBe(200);
    const asOther = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${created.id}`,
    );
    expect(asOther.status).toBe(404); // not 403 — don't confirm existence
  });

  it("an admin can read another user's canvas", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const admin = await seedUser(client, "admin", true);
    const created = await jsonOf<{ id: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const res = await buildApp(client, { id: admin.id, isAdmin: true }).request(
      `/api/canvases/${created.id}`,
    );
    expect(res.status).toBe(200);
  });

  it("settings: shared toggle, password set (argon2id hash) and clear", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const patched = await jsonOf<{ shared: boolean; hasPassword: boolean }>(
      await app.request(`/api/canvases/${created.id}/settings`, {
        method: "PATCH",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ shared: true, password: "hunter2" }),
      }),
    );
    expect(patched.shared).toBe(true);
    expect(patched.hasPassword).toBe(true);
    // the stored hash is a real argon2id hash that verifies
    const cv = await canvasesRepository(client).findById(created.id);
    expect(cv?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(cv?.passwordHash as string, "hunter2")).toBe(true);

    const cleared = await jsonOf<{ hasPassword: boolean }>(
      await app.request(`/api/canvases/${created.id}/settings`, {
        method: "PATCH",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ password: null }),
      }),
    );
    expect(cleared.hasPassword).toBe(false);
  });

  it("regenerate-slug changes the slug and the old no longer resolves; regenerate-key rotates", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await jsonOf<{ id: string; slug: string; apiKey: string }>(
      await app.request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const reslug = await jsonOf<{ slug: string }>(
      await app.request(`/api/canvases/${created.id}/regenerate-slug`, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
      }),
    );
    expect(reslug.slug).not.toBe(created.slug);
    expect(await canvasesRepository(client).findBySlug(created.slug)).toBeNull();

    const rekey = await jsonOf<{ apiKey: string }>(
      await app.request(`/api/canvases/${created.id}/regenerate-key`, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
      }),
    );
    expect(rekey.apiKey).toMatch(/^cd_/);
    expect(rekey.apiKey).not.toBe(created.apiKey);
  });

  it("DELETE soft-deletes and excludes from the owner's list", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    await app.request(`/api/canvases/${created.id}`, {
      method: "DELETE",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    const list = await jsonOf<{ canvases: unknown[] }>(await app.request("/api/canvases"));
    expect(list.canvases).toHaveLength(0);
  });

  it("rejects a cross-site mutating request", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const res = await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});

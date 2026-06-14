import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import { cloneService } from "../canvas/clone-service.js";
import { verifyPassword } from "../canvas/password.js";
import type { DbClient } from "../db/factory.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { filesRepository } from "../db/repositories/files.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import type { DeployEntry } from "../deploy/ingest.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { managementRoutes } from "./management.js";
import { meRoutes } from "./me.js";

const silent = pino({ level: "silent" });
const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Build a management app that authenticates as a chosen user (no gateway needed). */
function buildApp(
  client: DbClient,
  actor: { id: string; isAdmin: boolean },
  storage = memStorage(),
  // biome-ignore lint/suspicious/noExplicitAny: optional spy hub for revoke-hook tests
  hub?: any,
) {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const audit = createAuditLog(auditRepository(client), silent);
  const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
  const clone = cloneService({ canvases, versions, drafts, storage });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    // stand in for the foundation gateway: inject the authenticated user
    c.set("user", { id: actor.id, isAdmin: actor.isAdmin } as never);
    c.set("clientIp", "127.0.0.1");
    await next();
  });
  app.route("/api/me", meRoutes({ authMode: "dev" }));
  app.route(
    "/api/canvases",
    managementRoutes({
      config,
      canvases,
      versions,
      clone,
      audit,
      engine,
      usage: usageEventsRepository(client),
      files: filesRepository(client),
      aiUsage: aiUsageRepository(client),
      hub,
    }),
  );
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

// SQLite-only by design: these are HTTP route tests (auth, routing, response
// shaping) which are dialect-independent. The one dialect-sensitive new path —
// versions.findByIds' empty-array `in ()` case — is dual-dialect tested at the
// repo level in db/repositories/versions.test.ts. Running this whole suite on
// pglite would ~double its runtime for no additional SQL coverage.
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

  it("an OWNER cannot delete a disabled canvas (no takedown laundering via delete→restore, §12.0 #5)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const created = await jsonOf<{ id: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    await canvasesRepository(client).setDisabled(created.id, "abuse");
    // Owner delete → 409, canvas stays disabled (the admin must enable it first).
    const asOwner = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      `/api/canvases/${created.id}`,
      { method: "DELETE", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(asOwner.status).toBe(409);
    expect((await canvasesRepository(client).findById(created.id))?.status).toBe("disabled");
    // An admin CAN delete it (legitimate purge).
    const asAdmin = await buildApp(client, { id: "admin", isAdmin: true }).request(
      `/api/canvases/${created.id}`,
      { method: "DELETE", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(asAdmin.status).toBe(200);
  });

  it("a disabled canvas's reason reaches the OWNER but never a non-owner (M7, §12.0 #3)", async () => {
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
    // An admin takes it down with a reason.
    await canvasesRepository(client).setDisabled(created.id, "internal HR investigation");

    // Owner sees the reason in their own canvas detail (the "owner sees why" surface).
    const asOwner = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      `/api/canvases/${created.id}`,
    );
    expect(asOwner.status).toBe(200);
    expect((await jsonOf<{ disabledReason: string }>(asOwner)).disabledReason).toBe(
      "internal HR investigation",
    );

    // A non-owner 404s — they never receive the projection (or the operator's note).
    const asOther = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${created.id}`,
    );
    expect(asOther.status).toBe(404);
    expect(await asOther.text()).not.toContain("HR investigation");
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

  it("archive moves a canvas out of the active list and into the archive list", async () => {
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
    const res = await app.request(`/api/canvases/${created.id}/archive`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ status: string }>(res)).status).toBe("archived");

    const active = await jsonOf<{ canvases: unknown[] }>(await app.request("/api/canvases"));
    expect(active.canvases).toHaveLength(0); // gone from the active view

    const archived = await jsonOf<{ canvases: { id: string }[] }>(
      await app.request("/api/canvases/archived"),
    );
    expect(archived.canvases.map((c) => c.id)).toEqual([created.id]);
  });

  it("unarchive restores a canvas to the active list", async () => {
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
    await app.request(`/api/canvases/${created.id}/archive`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    const res = await app.request(`/api/canvases/${created.id}/unarchive`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ status: string }>(res)).status).toBe("active");

    const active = await jsonOf<{ canvases: { id: string }[] }>(await app.request("/api/canvases"));
    expect(active.canvases.map((c) => c.id)).toEqual([created.id]);
    const archived = await jsonOf<{ canvases: unknown[] }>(
      await app.request("/api/canvases/archived"),
    );
    expect(archived.canvases).toHaveLength(0);
  });

  it("unarchive on a non-archived canvas → 409", async () => {
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
    const res = await app.request(`/api/canvases/${created.id}/unarchive`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(409);
  });

  it("deploy and rollback on an archived canvas → 409 NOT_ACTIVE (unarchive first)", async () => {
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
    await app.request(`/api/canvases/${created.id}/archive`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    // A session deploy to a shelved canvas is refused — its public URL 404s, so
    // publishing to it would be incoherent. (The Bearer path already 401s archived.)
    const deploy = await app.request(`/api/canvases/${created.id}/deploy/paste`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ html: "<h1>hi</h1>" }),
    });
    expect(deploy.status).toBe(409);
    expect((await jsonOf<{ code: string }>(deploy)).code).toBe("NOT_ACTIVE");

    const rollback = await app.request(`/api/canvases/${created.id}/rollback`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(rollback.status).toBe(409);
    expect((await jsonOf<{ code: string }>(rollback)).code).toBe("NOT_ACTIVE");
  });

  it("a non-owner cannot archive (404, no existence leak); an admin can", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "intruder");
    const admin = await seedUser(client, "admin", true);
    const created = await jsonOf<{ id: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const denied = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/archive`,
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(denied.status).toBe(404);

    const asAdmin = await buildApp(client, { id: admin.id, isAdmin: true }).request(
      `/api/canvases/${created.id}/archive`,
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(asAdmin.status).toBe(200);
  });

  it("archive/unarchive require same-origin", async () => {
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
    const res = await app.request(`/api/canvases/${created.id}/archive`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("paste-HTML create returns a new canvas with a live index.html and the key once", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const res = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      "/api/canvases/paste",
      {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>pasted</h1>", title: "Pasted" }),
      },
    );
    expect(res.status).toBe(201);
    const body = await jsonOf<{
      slug: string;
      apiKey: string;
      currentVersionId: string | null;
      deploy: { version: number; fileCount: number };
    }>(res);
    expect(body.apiKey).toMatch(/^cd_/);
    expect(body.deploy.version).toBe(1);
    expect(body.deploy.fileCount).toBe(1);
  });

  it("owner can deploy via ZIP; a non-owner cannot", async () => {
    const { zipSync } = await import("fflate");
    const { Buffer } = await import("node:buffer");
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const created = await jsonOf<{ id: string; slug: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const zip = Buffer.from(zipSync({ "index.html": new TextEncoder().encode("<h1>z</h1>") }));
    const ok = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/deploy/zip`,
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" }, body: zip },
    );
    expect(ok.status).toBe(200);
    expect((await jsonOf<{ fileCount: number }>(ok)).fileCount).toBe(1);

    const denied = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/deploy/zip`,
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" }, body: zip },
    );
    expect(denied.status).toBe(404);
  });

  it("owner can deploy via folder multipart (field key = relative path)", async () => {
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
    const form = new FormData();
    form.set("index.html", new File(["<h1>folder</h1>"], "index.html", { type: "text/html" }));
    form.set("assets/app.js", new File(["console.log(1)"], "app.js", { type: "text/javascript" }));
    const res = await app.request(`/api/canvases/${created.id}/deploy/folder`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
      body: form,
    });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ fileCount: number }>(res)).fileCount).toBe(2);
  });

  it("owner can deploy a new version of an existing canvas via paste", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>v1</h1>" }),
      }),
    );
    const res = await app.request(`/api/canvases/${created.id}/deploy/paste`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ html: "<h1>v2</h1>" }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ version: number }>(res)).version).toBe(2);
    // A non-owner cannot deploy to it.
    const other = await seedUser(client, "intruder");
    const denied = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/deploy/paste`,
      {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>nope</h1>" }),
      },
    );
    expect(denied.status).toBe(404);
  });

  it("paste create rolls back the canvas (no orphan) when the embedded deploy fails", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const failing = memStorage();
    failing.put = async () => {
      throw new Error("storage down");
    };
    const app = buildApp(client, { id: owner.id, isAdmin: false }, failing);
    const res = await app.request("/api/canvases/paste", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ html: "<h1>x</h1>" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // no orphan canvas left behind
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

  it("GET /api/me returns exactly the projected fields (no spread leak)", async () => {
    client = await makeTestDb("sqlite");
    // Inject a full user row (incl. fields not in the projection) to prove the
    // response shape is an explicit allowlist, not a spread.
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", {
        id: "u1",
        email: "u1@example.com",
        name: "User One",
        avatarUrl: null,
        isAdmin: true,
        providerSub: "secret-sub",
        isBlocked: false,
        createdAt: 123,
      } as never);
      await next();
    });
    app.route("/api/me", meRoutes({ authMode: "oidc" }));
    const body = await jsonOf<Record<string, unknown>>(await app.request("/api/me"));
    expect(Object.keys(body).sort()).toEqual([
      "authMode",
      "avatarUrl",
      "email",
      "id",
      "isAdmin",
      "name",
    ]);
    expect(body.providerSub).toBeUndefined();
    expect(body.isBlocked).toBeUndefined();
    expect(body.isAdmin).toBe(true);
    // authMode is instance config, not a spread of the user row.
    expect(body.authMode).toBe("oidc");
  });

  it("list enriches each canvas with its lastDeploy summary (null until deployed)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    // one never-deployed canvas
    await app.request("/api/canvases", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: "{}",
    });
    // one deployed via paste
    await app.request("/api/canvases/paste", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ html: "<h1>x</h1>" }),
    });
    const list = await jsonOf<{ canvases: { lastDeploy: { version: number } | null }[] }>(
      await app.request("/api/canvases"),
    );
    const deploys = list.canvases.map((c) => c.lastDeploy);
    expect(deploys.filter((d) => d === null)).toHaveLength(1);
    expect(deploys.filter((d) => d?.version === 1)).toHaveLength(1);
  });

  it("versions: owner sees history with the current marker; a non-owner gets 404", async () => {
    const { zipSync } = await import("fflate");
    const { Buffer } = await import("node:buffer");
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const zip = (n: string) => Buffer.from(zipSync({ "index.html": new TextEncoder().encode(n) }));
    for (const n of ["<h1>1</h1>", "<h1>2</h1>"]) {
      await app.request(`/api/canvases/${created.id}/deploy/zip`, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
        body: zip(n),
      });
    }
    const hist = await jsonOf<{ versions: { number: number; current: boolean }[] }>(
      await app.request(`/api/canvases/${created.id}/versions`),
    );
    expect(hist.versions.map((v) => v.number)).toEqual([2, 1]); // newest first
    expect(hist.versions.find((v) => v.current)?.number).toBe(2);

    const denied = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/versions`,
    );
    expect(denied.status).toBe(404);
  });

  it("rollback: moves the pointer, rejects bad/cross-canvas versions, non-owner, cross-origin", async () => {
    const { zipSync } = await import("fflate");
    const { Buffer } = await import("node:buffer");
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const zip = (n: string) => Buffer.from(zipSync({ "index.html": new TextEncoder().encode(n) }));
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    for (const n of ["<h1>1</h1>", "<h1>2</h1>"]) {
      await app.request(`/api/canvases/${created.id}/deploy/zip`, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
        body: zip(n),
      });
    }
    // non-owner first (reject path before happy path)
    const asOther = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/rollback`,
      {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      },
    );
    expect(asOther.status).toBe(404);
    // cross-origin
    const xorig = await app.request(`/api/canvases/${created.id}/rollback`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site", "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(xorig.status).toBe(403);
    // missing / non-existent version
    expect(
      (
        await app.request(`/api/canvases/${created.id}/rollback`, {
          method: "POST",
          headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(`/api/canvases/${created.id}/rollback`, {
          method: "POST",
          headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
          body: JSON.stringify({ version: 99 }),
        })
      ).status,
    ).toBe(404);
    // cross-canvas: a version number that exists on ANOTHER owned canvas must not
    // resolve here (findReadyByNumber is canvas-scoped — §12.0 invariant #4).
    const otherCanvas = await jsonOf<{ id: string }>(
      await app.request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>other</h1>" }),
      }),
    );
    // `otherCanvas` now has a ready version 1; a version number only it has must
    // 404 on a different canvas — findReadyByNumber is canvas-scoped.
    expect(
      (
        await app.request(`/api/canvases/${otherCanvas.id}/rollback`, {
          method: "POST",
          headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
          body: JSON.stringify({ version: 2 }), // other has only v1
        })
      ).status,
    ).toBe(404);
    // happy path: roll back to v1, pointer moves
    const ok = await app.request(`/api/canvases/${created.id}/rollback`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(ok.status).toBe(200);
    const v1 = await versionsRepository(client).findReadyByNumber(created.id, 1);
    expect((await canvasesRepository(client).findById(created.id))?.currentVersionId).toBe(v1?.id);
  });

  // --- Capabilities (plan 006) ---

  type CapView = {
    id: string;
    apiKey?: string;
    backendEnabled: boolean;
    capabilities: { kv: boolean; files: boolean; ai: boolean; realtime: boolean };
    effective: { identity: boolean; kv: boolean; files: boolean; ai: boolean; realtime: boolean };
  };

  async function createCanvas(
    app: ReturnType<typeof buildApp>,
    payload: Record<string, unknown> = {},
  ): Promise<CapView> {
    const res = await app.request("/api/canvases", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    return jsonOf<CapView>(res);
  }

  it("create default: backend off, all feature flags stored on, nothing effective", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const body = await createCanvas(buildApp(client, { id: owner.id, isAdmin: false }));
    expect(body.backendEnabled).toBe(false);
    expect(body.capabilities).toEqual({ kv: true, files: true, ai: true, realtime: true });
    // backend off → nothing effective, including identity
    expect(body.effective.identity).toBe(false);
    expect(body.effective.kv).toBe(false);
  });

  it("create with backendEnabled:true → backend on, key still shown once (KTD-5)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const body = await createCanvas(buildApp(client, { id: owner.id, isAdmin: false }), {
      title: "App",
      backendEnabled: true,
    });
    expect(body.backendEnabled).toBe(true);
    expect(body.apiKey).toMatch(/^cd_/); // capability choice does NOT gate the key
    expect(body.effective.identity).toBe(true);
    expect(body.effective.kv).toBe(true);
  });

  it("effective ANDs the operator global: AI off when no provider configured", async () => {
    // Default test config has no CANVAS_DROP_AI_API_KEY, so ai is globally off.
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const body = await createCanvas(buildApp(client, { id: owner.id, isAdmin: false }), {
      backendEnabled: true,
    });
    expect(body.capabilities.ai).toBe(true); // stored flag is on
    expect(body.effective.ai).toBe(false); // but not effective (no provider)
    expect(body.effective.realtime).toBe(true); // realtime defaults on globally
  });

  it("public view never leaks the key/password hashes", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const body = (await createCanvas(buildApp(client, { id: owner.id, isAdmin: false }))) as Record<
      string,
      unknown
    >;
    expect(body.apiKeyHash).toBeUndefined();
    expect(body.passwordHash).toBeUndefined();
  });

  it("PATCH /capabilities toggles a feature, persists, and audits", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await createCanvas(app, { backendEnabled: true });
    const res = await app.request(`/api/canvases/${created.id}/capabilities`, {
      method: "PATCH",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ ai: false, backendEnabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<CapView>(res);
    expect(body.capabilities.ai).toBe(false);
    expect(body.capabilities.kv).toBe(true);
    const stored = await canvasesRepository(client).findById(created.id);
    expect(stored?.capAi).toBe(false);
  });

  it("PATCH /capabilities rejects an invalid body (400)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await createCanvas(app, { backendEnabled: true });
    const res = await app.request(`/api/canvases/${created.id}/capabilities`, {
      method: "PATCH",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ kv: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /capabilities is 404 for a non-owner (no existence leak)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const created = await createCanvas(buildApp(client, { id: owner.id, isAdmin: false }), {
      backendEnabled: true,
    });
    const res = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/capabilities`,
      {
        method: "PATCH",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ kv: false }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("PATCH /capabilities requires same-origin", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await createCanvas(app, { backendEnabled: true });
    const res = await app.request(`/api/canvases/${created.id}/capabilities`, {
      method: "PATCH",
      headers: { "Sec-Fetch-Site": "cross-site", "content-type": "application/json" },
      body: JSON.stringify({ kv: false }),
    });
    expect(res.status).toBe(403);
  });

  // --- Usage stats (U10) ---

  it("GET /:id/usage returns KV op, file storage, AI and realtime figures for the owner", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await createCanvas(app, { backendEnabled: true });
    // Seed a KV op + a realtime connect + a file row + an AI call.
    await usageEventsRepository(client).record({
      canvasId: created.id,
      userId: owner.id,
      type: "kv_op",
      meta: { op: "set" },
    });
    await usageEventsRepository(client).record({
      canvasId: created.id,
      userId: owner.id,
      type: "rt_connect",
    });
    await filesRepository(client).insert({
      id: "f1",
      canvasId: created.id,
      filename: "a.txt",
      mime: "text/plain",
      sizeBytes: 1234,
      storageKey: `files/${created.id}/f1`,
      uploadedBy: owner.id,
    });
    await aiUsageRepository(client).record({
      canvasId: created.id,
      userId: owner.id,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0125,
    });
    // One view (D24) → total + unique = 1, last-viewed set, sparkline populated.
    const now = Date.now();
    await usageEventsRepository(client).recordView({
      canvasId: created.id,
      userId: owner.id,
      windowMs: 60_000,
      now,
    });
    const res = await app.request(`/api/canvases/${created.id}/usage`);
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      totalViews: number;
      uniqueViewers: number;
      lastViewedAt: number | null;
      viewsByDay: Array<{ dayMs: number; count: number }>;
      kvOps: number;
      fileOps: number;
      fileCount: number;
      fileBytes: number;
      aiCalls: number;
      aiTokens: number;
      aiCostUsd: number;
      realtimeConnects: number;
    }>(res);
    expect(body).toMatchObject({
      kvOps: 1,
      fileOps: 0,
      fileCount: 1,
      fileBytes: 1234,
      aiCalls: 1,
      aiTokens: 150,
      aiCostUsd: 0.0125,
      realtimeConnects: 1,
      totalViews: 1,
      uniqueViewers: 1,
    });
    expect(body.lastViewedAt).toBe(now);
    // Dense 30-day series; today's bucket carries the view.
    expect(body.viewsByDay.length).toBeGreaterThanOrEqual(30);
    expect(body.viewsByDay.reduce((sum, d) => sum + d.count, 0)).toBe(1);
  });

  it("GET /:id/usage returns view stats even when the backend is off", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await createCanvas(app, { backendEnabled: false });
    await usageEventsRepository(client).recordView({
      canvasId: created.id,
      userId: owner.id,
      windowMs: 60_000,
      now: Date.now(),
    });
    const res = await app.request(`/api/canvases/${created.id}/usage`);
    expect(res.status).toBe(200);
    const body = await jsonOf<{ totalViews: number; uniqueViewers: number; kvOps: number }>(res);
    expect(body.totalViews).toBe(1);
    expect(body.uniqueViewers).toBe(1);
    expect(body.kvOps).toBe(0);
  });

  it("GET /:id/usage is 404 for a non-owner", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const created = await createCanvas(buildApp(client, { id: owner.id, isAdmin: false }), {});
    const res = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/usage`,
    );
    expect(res.status).toBe(404);
  });
});

describe("management realtime revoke hooks (D-RT-6)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  function spyHub() {
    const calls: Array<{ method: string; canvasId: string }> = [];
    return {
      calls,
      revalidateCanvas: async (id: string) => {
        calls.push({ method: "revalidateCanvas", canvasId: id });
      },
      dropGatedNonOwners: async (id: string) => {
        calls.push({ method: "dropGatedNonOwners", canvasId: id });
      },
      dropCanvas: (id: string) => {
        calls.push({ method: "dropCanvas", canvasId: id });
      },
    };
  }

  const mutate = (app: ReturnType<typeof buildApp>, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function setup() {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const cv = await canvasesRepository(client).create({
      ownerId: owner.id,
      slug: "app",
      apiKeyHash: "h-app",
    });
    const hub = spyHub();
    const app = buildApp(client, { id: owner.id, isAdmin: false }, memStorage(), hub);
    return { owner, cv, hub, app };
  }

  it("PATCH settings (un-share) revalidates; with a new password also drops gated non-owners", async () => {
    const { cv, hub, app } = await setup();
    expect(
      (await mutate(app, "PATCH", `/api/canvases/${cv.id}/settings`, { shared: false })).status,
    ).toBe(200);
    expect(hub.calls).toContainEqual({ method: "revalidateCanvas", canvasId: cv.id });
    expect(hub.calls.some((c) => c.method === "dropGatedNonOwners")).toBe(false);

    hub.calls.length = 0;
    expect(
      (await mutate(app, "PATCH", `/api/canvases/${cv.id}/settings`, { password: "hunter2pass" }))
        .status,
    ).toBe(200);
    expect(hub.calls).toContainEqual({ method: "revalidateCanvas", canvasId: cv.id });
    expect(hub.calls).toContainEqual({ method: "dropGatedNonOwners", canvasId: cv.id });
  });

  it("PATCH capabilities (realtime off) revalidates", async () => {
    const { cv, hub, app } = await setup();
    expect(
      (await mutate(app, "PATCH", `/api/canvases/${cv.id}/capabilities`, { realtime: false }))
        .status,
    ).toBe(200);
    expect(hub.calls).toContainEqual({ method: "revalidateCanvas", canvasId: cv.id });
  });

  it("regenerate-slug drops the whole canvas; delete revalidates", async () => {
    const { cv, hub, app } = await setup();
    expect((await mutate(app, "POST", `/api/canvases/${cv.id}/regenerate-slug`)).status).toBe(200);
    expect(hub.calls).toContainEqual({ method: "dropCanvas", canvasId: cv.id });

    hub.calls.length = 0;
    expect((await mutate(app, "DELETE", `/api/canvases/${cv.id}`)).status).toBe(200);
    expect(hub.calls).toContainEqual({ method: "revalidateCanvas", canvasId: cv.id });
  });
});

const enc = (s: string) => new TextEncoder().encode(s);
async function* folder(files: Record<string, string>): AsyncGenerator<DeployEntry> {
  for (const [path, body] of Object.entries(files)) yield { path, bytes: enc(body) };
}
const sameOriginPost = {
  method: "POST",
  headers: { "Sec-Fetch-Site": "same-origin" as const },
};

describe("managementRoutes — clone (plan 002 U4)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** Publish a canvas owned by `ownerId` into `storage`, applying optional gallery settings. */
  async function seedCanvas(
    storage: ReturnType<typeof memStorage>,
    ownerId: string,
    opts: {
      slug: string;
      apiKeyHash: string;
      publish?: boolean;
      settings?: Parameters<ReturnType<typeof canvasesRepository>["updateSettings"]>[1];
    },
  ) {
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
    const cv = await canvases.create({ ownerId, slug: opts.slug, apiKeyHash: opts.apiKeyHash });
    if (opts.publish !== false) {
      await engine.deploy(cv, "folder", folder({ "index.html": "<h1>hi</h1>" }), ownerId);
    }
    if (opts.settings) await canvases.updateSettings(cv.id, opts.settings);
    return (await canvases.findById(cv.id)) as NonNullable<
      Awaited<ReturnType<typeof canvases.findById>>
    >;
  }

  it("owner clones their own active canvas → 201, new owned canvas, unpublished draft", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const src = await seedCanvas(storage, owner.id, { slug: "src", apiKeyHash: "k1" });

    const res = await buildApp(client, { id: owner.id, isAdmin: false }, storage).request(
      `/api/canvases/${src.id}/clone`,
      sameOriginPost,
    );
    expect(res.status).toBe(201);
    const body = await jsonOf<{
      id: string;
      title: string;
      apiKey?: string;
      galleryListed: boolean;
    }>(res);
    expect(body.id).not.toBe(src.id);
    // The clone's key is NOT returned (revealed via Settings → Regenerate key instead).
    expect(body.apiKey).toBeUndefined();
    expect(body.galleryListed).toBe(false);
    const clone = await canvasesRepository(client).findById(body.id);
    expect(clone?.ownerId).toBe(owner.id);
    expect(clone?.currentVersionId).toBeNull(); // clone-to-draft
    expect(clone?.clonedFromCanvasId).toBe(src.id);
  });

  it("owner cannot clone their own ARCHIVED canvas → 404", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const src = await seedCanvas(storage, owner.id, { slug: "src", apiKeyHash: "k1" });
    await canvasesRepository(client).archive(src.id);

    const res = await buildApp(client, { id: owner.id, isAdmin: false }, storage).request(
      `/api/canvases/${src.id}/clone`,
      sameOriginPost,
    );
    expect(res.status).toBe(404);
  });

  it("non-owner clones a listed + templatable + published canvas → 201", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const src = await seedCanvas(storage, owner.id, {
      slug: "tmpl",
      apiKeyHash: "k1",
      settings: { shared: true, galleryListed: true, galleryTemplatable: true },
    });

    const res = await buildApp(client, { id: other.id, isAdmin: false }, storage).request(
      `/api/canvases/${src.id}/clone`,
      sameOriginPost,
    );
    expect(res.status).toBe(201);
    const body = await jsonOf<{ id: string }>(res);
    expect((await canvasesRepository(client).findById(body.id))?.ownerId).toBe(other.id);
  });

  it("non-owner cannot clone a listed-but-NOT-templatable canvas → 404 (opaque)", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const src = await seedCanvas(storage, owner.id, {
      slug: "tmpl",
      apiKeyHash: "k1",
      settings: { shared: true, galleryListed: true }, // not templatable
    });

    const res = await buildApp(client, { id: other.id, isAdmin: false }, storage).request(
      `/api/canvases/${src.id}/clone`,
      sameOriginPost,
    );
    expect(res.status).toBe(404);
  });

  it("non-owner cannot clone a templatable canvas that is NOT shared → 404", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    // listed + templatable but shared=false → fails the §12 predicate.
    const src = await seedCanvas(storage, owner.id, {
      slug: "tmpl",
      apiKeyHash: "k1",
      settings: { galleryListed: true, galleryTemplatable: true },
    });

    const res = await buildApp(client, { id: other.id, isAdmin: false }, storage).request(
      `/api/canvases/${src.id}/clone`,
      sameOriginPost,
    );
    expect(res.status).toBe(404);
  });

  it("non-owner cannot clone a templatable canvas that was never published → 404", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const src = await seedCanvas(storage, owner.id, {
      slug: "tmpl",
      apiKeyHash: "k1",
      publish: false,
      settings: { shared: true, galleryListed: true, galleryTemplatable: true },
    });

    const res = await buildApp(client, { id: other.id, isAdmin: false }, storage).request(
      `/api/canvases/${src.id}/clone`,
      sameOriginPost,
    );
    expect(res.status).toBe(404);
  });
});

describe("managementRoutes — listability rules (plan 002 U5)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** Publish (optionally) a canvas owned by `ownerId` and return its id. */
  async function makeCanvas(ownerId: string, publish: boolean): Promise<string> {
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const engine = deployEngine({
      config,
      canvases,
      versions,
      drafts,
      storage: memStorage(),
      log: silent,
    });
    const cv = await canvases.create({
      ownerId,
      slug: `s-${ownerId}-${publish}`,
      apiKeyHash: `k-${ownerId}-${publish}`,
    });
    if (publish) await engine.deploy(cv, "folder", folder({ "index.html": "<h1>x</h1>" }), ownerId);
    return cv.id;
  }

  function patch(app: ReturnType<typeof buildApp>, id: string, body: unknown) {
    return app.request(`/api/canvases/${id}/settings`, {
      method: "PATCH",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects listing a never-published canvas, then allows it after publishing", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });

    const unpublished = await makeCanvas(owner.id, false);
    expect((await patch(app, unpublished, { shared: true, galleryListed: true })).status).toBe(409);

    const published = await makeCanvas(owner.id, true);
    const res = await patch(app, published, { shared: true, galleryListed: true });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ galleryListed: boolean }>(res)).galleryListed).toBe(true);
  });

  it("setting a password on a listed canvas un-lists it and clears templatable", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const id = await makeCanvas(owner.id, true);
    await patch(app, id, { shared: true, galleryListed: true, galleryTemplatable: true });

    const res = await patch(app, id, { password: "secret" });
    const body = await jsonOf<{
      galleryListed: boolean;
      galleryTemplatable: boolean;
      hasPassword: boolean;
    }>(res);
    expect(body.hasPassword).toBe(true);
    expect(body.galleryListed).toBe(false);
    expect(body.galleryTemplatable).toBe(false);
  });

  it("rejects listing a password-protected canvas", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const id = await makeCanvas(owner.id, true);
    await patch(app, id, { password: "secret" });

    expect((await patch(app, id, { shared: true, galleryListed: true })).status).toBe(409);
  });

  it("rejects templatable while unlisted, and un-listing clears templatable", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const id = await makeCanvas(owner.id, true);

    // Templatable while unlisted → rejected.
    expect((await patch(app, id, { galleryTemplatable: true })).status).toBe(409);

    // List + templatable, then un-list → templatable cleared.
    await patch(app, id, { shared: true, galleryListed: true, galleryTemplatable: true });
    const res = await patch(app, id, { galleryListed: false });
    const body = await jsonOf<{ galleryListed: boolean; galleryTemplatable: boolean }>(res);
    expect(body.galleryListed).toBe(false);
    expect(body.galleryTemplatable).toBe(false);
  });
});

describe("managementRoutes — clone + listability edge cases (plan 002 review)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function publish(storage: ReturnType<typeof memStorage>, ownerId: string, slug: string) {
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
    const cv = await canvases.create({ ownerId, slug, apiKeyHash: `k-${slug}` });
    await engine.deploy(cv, "folder", folder({ "index.html": "<h1>x</h1>" }), ownerId);
    return cv.id;
  }

  function patch(app: ReturnType<typeof buildApp>, id: string, body: unknown) {
    return app.request(`/api/canvases/${id}/settings`, {
      method: "PATCH",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects listing a published-but-UNSHARED canvas (NOT_SHARED)", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false }, storage);
    const id = await publish(storage, owner.id, "src");

    const res = await patch(app, id, { galleryListed: true }); // no shared:true
    expect(res.status).toBe(409);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("NOT_SHARED");
  });

  it("un-sharing a listed+templatable canvas clears listing/templatable but KEEPS summary+tags", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false }, storage);
    const id = await publish(storage, owner.id, "src");
    await patch(app, id, {
      shared: true,
      galleryListed: true,
      galleryTemplatable: true,
      gallerySummary: "a handy starter",
      galleryTags: ["starter"],
    });

    const res = await patch(app, id, { shared: false });
    const body = await jsonOf<{
      galleryListed: boolean;
      galleryTemplatable: boolean;
      gallerySummary: string | null;
      galleryTags: string[] | null;
    }>(res);
    expect(body.galleryListed).toBe(false);
    expect(body.galleryTemplatable).toBe(false);
    // Metadata is retained so re-sharing restores it without re-typing.
    expect(body.gallerySummary).toBe("a handy starter");
    expect(body.galleryTags).toEqual(["starter"]);
  });

  it("rejects {shared:false, galleryListed:true} in one PATCH (NOT_SHARED)", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false }, storage);
    const id = await publish(storage, owner.id, "src");
    await patch(app, id, { shared: true }); // currently shared

    // Atomically un-share AND request listing → the willBeShared check rejects it.
    const res = await patch(app, id, { shared: false, galleryListed: true });
    expect(res.status).toBe(409);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("NOT_SHARED");
  });

  it("owner cannot clone their own DISABLED canvas → 404", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const id = await publish(storage, owner.id, "src");
    await canvasesRepository(client).setDisabled(id, "abuse");

    const res = await buildApp(client, { id: owner.id, isAdmin: false }, storage).request(
      `/api/canvases/${id}/clone`,
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(res.status).toBe(404);
  });

  // ── GET / server-side filter/search/sort/page (plan 005) ─────────────────

  it("GET / returns the paged shape with defaults and no params", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    await repo.create({ ownerId: owner.id, slug: "one", apiKeyHash: "k1", title: "One" });
    await repo.create({ ownerId: owner.id, slug: "two", apiKeyHash: "k2", title: "Two" });

    const res = await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases");
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      canvases: Array<{ id: string; lastDeploy: unknown }>;
      total: number;
      limit: number;
      offset: number;
    }>(res);
    expect(body.total).toBe(2);
    expect(body.canvases).toHaveLength(2);
    expect(body.limit).toBe(24);
    expect(body.offset).toBe(0);
    // withLastDeploy enrichment is preserved (null for never-deployed canvases).
    expect(body.canvases[0]).toHaveProperty("lastDeploy");
  });

  it("GET /?template=1 returns only matching canvases, still enriched", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const tmpl = await repo.create({ ownerId: owner.id, slug: "tmpl", apiKeyHash: "k1" });
    await repo.create({ ownerId: owner.id, slug: "plain", apiKeyHash: "k2" });
    await repo.updateSettings(tmpl.id, { galleryTemplatable: true });

    const res = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      "/api/canvases?template=1",
    );
    const body = await jsonOf<{ canvases: Array<{ id: string }>; total: number }>(res);
    expect(body.total).toBe(1);
    expect(body.canvases.map((c) => c.id)).toEqual([tmpl.id]);
    expect(body.canvases[0]).toHaveProperty("lastDeploy");
  });

  it("GET / honors sort and falls back to the default axis on a junk sort value", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    await repo.create({ ownerId: owner.id, slug: "a", apiKeyHash: "k1", title: "Banana" });
    await repo.create({ ownerId: owner.id, slug: "b", apiKeyHash: "k2", title: "apple" });

    const sorted = await jsonOf<{ canvases: Array<{ title: string }> }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases?sort=title"),
    );
    expect(sorted.canvases.map((c) => c.title)).toEqual(["apple", "Banana"]);

    // A junk sort value must not 400 — it falls back to the default axis.
    const junk = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      "/api/canvases?sort=wat",
    );
    expect(junk.status).toBe(200);
  });

  it("GET / clamps limit/offset and tolerates non-numeric values", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    for (let i = 0; i < 3; i++) {
      await repo.create({ ownerId: owner.id, slug: `c${i}`, apiKeyHash: `k${i}` });
    }
    // limit over the max clamps to 60; negative offset clamps to 0.
    const over = await jsonOf<{ limit: number; offset: number; total: number }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request(
        "/api/canvases?limit=9999&offset=-5",
      ),
    );
    expect(over.limit).toBe(60);
    expect(over.offset).toBe(0);
    expect(over.total).toBe(3);
    // non-numeric limit falls back to the default page size, not a 400.
    const junk = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      "/api/canvases?limit=abc",
    );
    expect(junk.status).toBe(200);
    expect((await jsonOf<{ limit: number }>(junk)).limit).toBe(24);
  });

  it("GET / never returns another user's canvas, even with permissive params", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const repo = canvasesRepository(client);
    await repo.create({ ownerId: owner.id, slug: "mine", apiKeyHash: "k1" });
    await repo.create({ ownerId: other.id, slug: "theirs", apiKeyHash: "k2" });

    const body = await jsonOf<{ canvases: Array<{ slug: string }>; total: number }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases"),
    );
    expect(body.total).toBe(1);
    expect(body.canvases.map((c) => c.slug)).toEqual(["mine"]);
  });

  it("GET /?q= filters by title/slug, and boolFlag params reach the repo", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    await repo.create({
      ownerId: owner.id,
      slug: "alpha",
      apiKeyHash: "k1",
      title: "Alpha widget",
    });
    await repo.create({ ownerId: owner.id, slug: "beta", apiKeyHash: "k2", title: "Beta gadget" });

    // q= is trimmed, plumbed to the repo, and matches title (or slug), case-insensitively.
    const search = await jsonOf<{ canvases: Array<{ slug: string }>; total: number }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases?q=widget"),
    );
    expect(search.total).toBe(1);
    expect(search.canvases.map((c) => c.slug)).toEqual(["alpha"]);

    // boolFlag coercion reaches the repo: neither canvas is shared → ?shared=1 is empty
    // (it would be 2 if the flag were dropped on the way to listByOwnerFiltered).
    const shared = await jsonOf<{ total: number }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases?shared=1"),
    );
    expect(shared.total).toBe(0);
  });

  it("GET / returns an empty page (not a 404) when offset is past the total", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    await canvasesRepository(client).create({ ownerId: owner.id, slug: "only", apiKeyHash: "k1" });

    const res = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      "/api/canvases?offset=50",
    );
    expect(res.status).toBe(200);
    const body = await jsonOf<{ canvases: unknown[]; total: number; offset: number }>(res);
    expect(body.total).toBe(1);
    expect(body.canvases).toHaveLength(0);
    expect(body.offset).toBe(50);
  });
});

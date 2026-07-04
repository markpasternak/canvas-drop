import { type Config, loadConfig } from "@canvas-drop/shared";
import { zipSync } from "fflate";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditLog } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { authoringUsageRepository } from "../db/repositories/authoring-usage.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { canvasApiRoutes } from "./canvas-api.js";

const silent = pino({ level: "silent" });

/** authoring ON (operator switch), generous quota, all common rungs allowed. */
function cfg(over: Record<string, string> = {}): Config {
  return loadConfig({
    CANVAS_DROP_AUTH_MODE: "dev",
    CANVAS_DROP_AUTHORING: "on",
    CANVAS_DROP_AUTHORING_USER_DAILY_MAX: "20",
    CANVAS_DROP_AUTHORING_USER_TOTAL_MAX: "200",
    CANVAS_DROP_AUTHORING_ALLOWED_RUNGS: "private,specific_people,public_link",
    CANVAS_DROP_AUTHORING_MAX_EXPIRY_DAYS: "0",
    CANVAS_DROP_AUTHORING_REQUIRE_EXPIRY: "false",
    ...over,
  });
}
const ON = cfg();

type AuditEvent = { action: string; actorId?: string; targetId?: string; meta?: unknown };
function fakeAudit(): { audit: AuditLog; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  const audit = {
    recordAudit: (e: AuditEvent) => {
      events.push(e);
    },
  } as unknown as AuditLog;
  return { audit, events };
}

function zipFile(files: Record<string, string> = { "index.html": "<h1>authored</h1>" }): File {
  const bytes = zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])),
  );
  return new File([bytes], "bundle.zip", { type: "application/zip" });
}

function publishBody(meta: Record<string, unknown>, bundle: File = zipFile()): FormData {
  const fd = new FormData();
  fd.set("metadata", JSON.stringify(meta));
  fd.set("bundle", bundle);
  return fd;
}

async function seedUser(client: DbClient, sub = "owner", isAdmin = false) {
  return usersRepository(client).upsert({
    providerSub: sub,
    email: `${sub}@example.com`,
    name: sub,
    isAdmin,
  });
}

/** Seed source canvas A (backend + authoring on unless disabled). */
async function makeSource(
  client: DbClient,
  opts: { backendEnabled?: boolean; capAuthoring?: boolean; sub?: string } = {},
) {
  const owner = await seedUser(client, opts.sub ?? "owner");
  const repo = canvasesRepository(client);
  const cv = await repo.create({
    ownerId: owner.id,
    slug: "app",
    apiKeyHash: "h-app",
    backendEnabled: opts.backendEnabled ?? true,
  });
  if ((opts.capAuthoring ?? true) === true)
    await repo.updateCapabilities(cv.id, { authoring: true });
  return { owner, cv };
}

/** A specific_people source canvas with a guest on the allowlist (for the guest test). */
async function makeGuestSource(client: DbClient, guestEmail: string) {
  const { owner, cv } = await makeSource(client);
  const repo = canvasesRepository(client);
  await repo.setAccess(cv.id, "specific_people");
  await repo.addAllowlistEntry({ canvasId: cv.id, principalKind: "guest", email: guestEmail });
  return { owner, cv };
}

type Setup = (c: import("hono").Context<AppEnv>) => void;
const asMember =
  (userId: string, isAdmin = false): Setup =>
  (c) =>
    c.set("user", {
      id: userId,
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
      isAdmin,
    } as never);
const asGuest =
  (email: string, canvasId: string): Setup =>
  (c) =>
    c.set("principal", {
      kind: "guest",
      id: `guest:${email}`,
      inviteId: "inv1",
      canvasId,
      email,
    } as never);

function buildApi(client: DbClient, setup: Setup, config = ON) {
  const { audit, events } = fakeAudit();
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    setup(c);
    await next();
  });
  app.route(
    "/v1/c/:slug",
    canvasApiRoutes({
      config,
      canvases,
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      kv: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      files: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      usage: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: unused primitives in this suite
      aiUsage: {} as any,
      // The AI route mounts unconditionally and needs a provider; unused here.
      // biome-ignore lint/suspicious/noExplicitAny: unused primitive in this suite
      aiProvider: {} as any,
      audit,
      engine,
      authoringUsage: authoringUsageRepository(client),
    }),
  );
  return { app, events, canvases };
}

const publish = (app: Hono<AppEnv>, body: FormData) =>
  app.request("/v1/c/app/authoring", { method: "POST", body });

describe("canvasAuthoringRoutes — POST / (publish)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("403 CAPABILITY_DISABLED when backend is off", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client, { backendEnabled: false });
    const { app } = buildApi(client, asMember(owner.id));
    const res = await publish(app, publishBody({ title: "B" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("CAPABILITY_DISABLED");
  });

  it("403 CAPABILITY_DISABLED when the operator instance switch is off", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client); // canvas cap on, but operator off:
    const { app } = buildApi(client, asMember(owner.id), cfg({ CANVAS_DROP_AUTHORING: "off" }));
    const res = await publish(app, publishBody({ title: "B" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("CAPABILITY_DISABLED");
  });

  it("403 CAPABILITY_DISABLED when the per-canvas authoring flag is off", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client, { capAuthoring: false });
    const { app } = buildApi(client, asMember(owner.id));
    const res = await publish(app, publishBody({ title: "B" }));
    expect(res.status).toBe(403);
  });

  it("401 NOT_AUTHENTICATED for a guest viewer (and no canvas is created)", async () => {
    client = await makeTestDb("sqlite");
    const guestEmail = "guest@example.com";
    const src = await makeGuestSource(client, guestEmail);
    const { app, canvases } = buildApi(client, asGuest(guestEmail, src.cv.id));
    const res = await publish(app, publishBody({ title: "B" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_AUTHENTICATED");
    // no authored row was written for the guest identity
    expect(await authoringUsageRepository(client).countByActor(`guest:${guestEmail}`)).toBe(0);
    void canvases;
  });

  it("429 QUOTA_EXCEEDED (user_daily) when the daily cap is hit", async () => {
    client = await makeTestDb("sqlite");
    const { owner, cv } = await makeSource(client);
    // Pre-seed one authored row so dailyCount(1) >= dailyMax(1).
    await authoringUsageRepository(client).record({
      actorId: owner.id,
      sourceCanvasId: cv.id,
      authoredCanvasId: cv.id,
    });
    const { app } = buildApi(
      client,
      asMember(owner.id),
      cfg({ CANVAS_DROP_AUTHORING_USER_DAILY_MAX: "1" }),
    );
    const res = await publish(app, publishBody({ title: "B" }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; scope: string };
    expect(body.code).toBe("QUOTA_EXCEEDED");
    expect(body.scope).toBe("user_daily");
  });

  it("400 INVALID_BODY for a disallowed access rung", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    // Only private allowed; requesting public_link is rejected.
    const { app } = buildApi(
      client,
      asMember(owner.id),
      cfg({ CANVAS_DROP_AUTHORING_ALLOWED_RUNGS: "private" }),
    );
    const res = await publish(app, publishBody({ title: "B", access: "public_link" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_BODY");
  });

  it("400 INVALID_BODY for an over-max / missing-required expiry", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const c1 = cfg({ CANVAS_DROP_AUTHORING_MAX_EXPIRY_DAYS: "1" });
    const over = await publish(
      buildApi(client, asMember(owner.id), c1).app,
      publishBody({ title: "B", access: "public_link", expiresAt: Date.now() + 10 * 86_400_000 }),
    );
    expect(over.status).toBe(400);

    const c2 = cfg({ CANVAS_DROP_AUTHORING_REQUIRE_EXPIRY: "true" });
    const missing = await publish(
      buildApi(client, asMember(owner.id), c2).app,
      publishBody({ title: "B", access: "public_link" }),
    );
    expect(missing.status).toBe(400);
  });

  it("happy path: creates as the viewer, deploys, applies share settings, meters, audits", async () => {
    client = await makeTestDb("sqlite");
    const { owner, cv } = await makeSource(client);
    const { app, events, canvases } = buildApi(client, asMember(owner.id));
    const expiresAt = Date.now() + 5 * 86_400_000;
    const res = await publish(
      app,
      publishBody({ title: "Snapshot", access: "public_link", tags: ["roadmap"], expiresAt }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; url: string };
    expect(body.id).toBeTruthy();
    expect(body.url).toContain("http");

    const b = await canvases.findById(body.id);
    expect(b?.ownerId).toBe(owner.id); // real per-user ownership
    expect(b?.title).toBe("Snapshot");
    expect(b?.access).toBe("public_link");
    expect(b?.tags).toEqual(["roadmap"]);
    expect(b?.sharedExpiresAt).toBe(expiresAt);
    expect(b?.currentVersionId).toBeTruthy(); // the bundle deployed

    expect(await authoringUsageRepository(client).countByActor(owner.id)).toBe(1);
    const authored = events.find((e) => e.action === "canvas_authored");
    expect(authored).toMatchObject({
      actorId: owner.id,
      targetId: body.id,
      meta: { sourceCanvasId: cv.id },
    });
  });

  it("password access sets a password + public_link rung", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const { app, canvases } = buildApi(client, asMember(owner.id));
    const res = await publish(
      app,
      publishBody({ title: "B", access: "password", password: "hunter2" }),
    );
    expect(res.status).toBe(200);
    const b = await canvases.findById(((await res.json()) as { id: string }).id);
    expect(b?.access).toBe("public_link");
    expect(b?.passwordHash).toBeTruthy();
  });

  it("502 PUBLISH_FAILED carrying the id when the bundle can't deploy (no auto-revoke, no quota burn)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const { app, canvases } = buildApi(client, asMember(owner.id));
    const corrupt = new File([new Uint8Array([1, 2, 3, 4])], "bad.zip", {
      type: "application/zip",
    });
    const res = await publish(app, publishBody({ title: "B" }, corrupt));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; id: string };
    expect(body.code).toBe("PUBLISH_FAILED");
    expect(body.id).toBeTruthy();
    // The empty canvas still exists (return-id, not auto-revoke) and no quota was burned.
    expect(await canvases.findById(body.id)).toBeTruthy();
    expect(await authoringUsageRepository(client).countByActor(owner.id)).toBe(0);
  });
});

describe("canvasAuthoringRoutes — list + revoke", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("GET / lists only the viewer's own authored canvases", async () => {
    client = await makeTestDb("sqlite");
    const { owner, cv } = await makeSource(client);
    const other = await seedUser(client, "other");
    const otherCanvas = await canvasesRepository(client).create({
      ownerId: other.id,
      slug: "other",
      apiKeyHash: "h-o",
    });
    const usage = authoringUsageRepository(client);
    await usage.record({ actorId: owner.id, sourceCanvasId: cv.id, authoredCanvasId: cv.id });
    await usage.record({
      actorId: other.id,
      sourceCanvasId: otherCanvas.id,
      authoredCanvasId: otherCanvas.id,
    });

    const { app } = buildApi(client, asMember(owner.id));
    const res = await app.request("/v1/c/app/authoring", { method: "GET" });
    expect(res.status).toBe(200);
    const { canvases } = (await res.json()) as { canvases: Array<{ id: string }> };
    expect(canvases.map((c) => c.id)).toEqual([cv.id]);
  });

  it("DELETE /:id revokes the viewer's own canvas (204); another owner's id is 404 (no leak)", async () => {
    client = await makeTestDb("sqlite");
    const { owner, cv } = await makeSource(client);
    const other = await seedUser(client, "other");
    const otherCanvas = await canvasesRepository(client).create({
      ownerId: other.id,
      slug: "other",
      apiKeyHash: "h-o",
    });
    const { app, canvases } = buildApi(client, asMember(owner.id));

    const notMine = await app.request(`/v1/c/app/authoring/${otherCanvas.id}`, {
      method: "DELETE",
    });
    expect(notMine.status).toBe(404);
    expect((await canvases.findById(otherCanvas.id))?.status).not.toBe("deleted");

    const mine = await app.request(`/v1/c/app/authoring/${cv.id}`, { method: "DELETE" });
    expect(mine.status).toBe(204);
    expect((await canvases.findById(cv.id))?.status).toBe("deleted");
  });
});

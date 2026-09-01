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
    CANVAS_DROP_AUTHORING_ALLOWED_RUNGS: "private,specific_people,whole_org,public_link",
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
  (userId: string, opts: { isAdmin?: boolean; canPublishPublic?: boolean } = {}): Setup =>
  (c) =>
    c.set("user", {
      id: userId,
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
      isAdmin: opts.isAdmin ?? false,
      canPublishPublic: opts.canPublishPublic ?? true,
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

function buildApi(
  client: DbClient,
  setup: Setup,
  config = ON,
  opts: { publicLinksEnabled?: boolean } = {},
) {
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
      publicLinksEnabled: async () => opts.publicLinksEnabled ?? true,
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

  it("publishes a whole-org share when that rung is allowed", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const config = cfg({ CANVAS_DROP_AUTHORING_ALLOWED_RUNGS: "whole_org" });
    const { app, canvases } = buildApi(client, asMember(owner.id), config);

    const res = await publish(
      app,
      publishBody({
        title: "Roadmap snapshot",
        access: "whole_org",
        expiresAt: Date.now() + 5 * 86_400_000,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect((await canvases.findById(body.id))?.access).toBe("whole_org");
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

  it("502 PUBLISH_FAILED carries the id when deploy fails (no auto-revoke) and STILL counts against quota", async () => {
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
    // The canvas still exists (return-id, not auto-revoke) AND was metered on creation,
    // so a loop of failing publishes can't mint unlimited uncounted orphans (quota bypass fix).
    expect(await canvases.findById(body.id)).toBeTruthy();
    expect(await authoringUsageRepository(client).countByActor(owner.id)).toBe(1);
  });

  it("public_link is refused when the instance switch is off (PUBLIC_LINKS_DISABLED) or the account is revoked (PUBLIC_NOT_ALLOWED)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    // Instance switch off → 403, and no canvas is created.
    const off = buildApi(client, asMember(owner.id), ON, { publicLinksEnabled: false });
    const r1 = await publish(off.app, publishBody({ title: "B", access: "public_link" }));
    expect(r1.status).toBe(403);
    expect(((await r1.json()) as { code: string }).code).toBe("PUBLIC_LINKS_DISABLED");
    expect(await authoringUsageRepository(client).countByActor(owner.id)).toBe(0);

    // Per-account grant revoked → 403 PUBLIC_NOT_ALLOWED (instance switch on).
    const revoked = buildApi(client, asMember(owner.id, { canPublishPublic: false }));
    const r2 = await publish(revoked.app, publishBody({ title: "B", access: "public_link" }));
    expect(r2.status).toBe(403);
    expect(((await r2.json()) as { code: string }).code).toBe("PUBLIC_NOT_ALLOWED");
  });

  it("a colliding CUSTOM slug returns 409 SLUG_TAKEN (not a misleading PUBLISH_FAILED)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    // A valid, non-reserved slug that is already taken → resolveCreateSlug passes it
    // through (custom slugs aren't uniqueness-checked there), so the collision surfaces
    // as a DB unique violation in create() and must map to 409, not 502.
    await canvasesRepository(client).create({
      ownerId: owner.id,
      slug: "roadmap-snapshot",
      apiKeyHash: "h-taken",
    });
    const { app } = buildApi(client, asMember(owner.id));
    const res = await publish(app, publishBody({ title: "B", slug: "roadmap-snapshot" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("SLUG_TAKEN");
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
    // Revoke keeps the record (status stays active) but stamps revoked_at + unpublishes,
    // so the row remains listed for the creator as "revoked" (not soft-deleted/hidden).
    const revoked = await canvases.findById(cv.id);
    expect(revoked?.status).toBe("active");
    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked?.currentVersionId).toBeNull();
  });
});

/** FormData with a metadata part + optional bundle (bundle omitted for settings-only updates). */
function formData(meta: Record<string, unknown>, bundle?: File): FormData {
  const fd = new FormData();
  fd.set("metadata", JSON.stringify(meta));
  if (bundle) fd.set("bundle", bundle);
  return fd;
}
const putUpdate = (app: Hono<AppEnv>, id: string, body: FormData) =>
  app.request(`/v1/c/app/authoring/${id}`, { method: "PUT", body });
type AuthoredCanvas = {
  id: string;
  url: string;
  status: string;
  version: string | null;
  tags: string[];
  access: string;
  metadata: Record<string, unknown>;
  sourceApp: string | null;
  expiresAt: number | null;
};

describe("canvasAuthoringRoutes — managed shares (v2)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("update replaces the bundle IN PLACE — same URL, new version (AE1)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const { app } = buildApi(client, asMember(owner.id));
    const pub = (await (
      await publish(app, publishBody({ title: "S", access: "private" }))
    ).json()) as AuthoredCanvas;
    expect(pub.version).toBeTruthy();

    const upd = await putUpdate(
      app,
      pub.id,
      formData({}, zipFile({ "index.html": "<h1>v2</h1>" })),
    );
    expect(upd.status).toBe(200);
    const updated = (await upd.json()) as AuthoredCanvas;
    expect(updated.url).toBe(pub.url); // URL never changes
    expect(updated.version).toBeTruthy();
    expect(updated.version).not.toBe(pub.version); // a new immutable version was deployed
  });

  it("update does NOT consume the authoring quota (AE1 / KTD2)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const { app } = buildApi(client, asMember(owner.id));
    const pub = (await (
      await publish(app, publishBody({ title: "S", access: "private" }))
    ).json()) as AuthoredCanvas;
    await putUpdate(app, pub.id, formData({ title: "S2" }));
    await putUpdate(app, pub.id, formData({}, zipFile({ "index.html": "<h1>v3</h1>" })));
    // publish counted once; two updates count zero.
    expect(await authoringUsageRepository(client).countByActor(owner.id)).toBe(1);
  });

  it("update changing access to public_link re-runs the admin gates (PUBLIC_NOT_ALLOWED)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const pub = (await (
      await publish(
        buildApi(client, asMember(owner.id)).app,
        publishBody({ title: "S", access: "private" }),
      )
    ).json()) as AuthoredCanvas;
    // Same owner, but public-publish revoked → update to public_link is refused.
    const revokedApp = buildApi(client, asMember(owner.id, { canPublishPublic: false })).app;
    const res = await putUpdate(revokedApp, pub.id, formData({ access: "public_link" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("PUBLIC_NOT_ALLOWED");
  });

  it("publish validates the DEFAULTED (omitted) access rung against allowedRungs", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    // Operator allows only public_link — an omitted access defaults to private, which is
    // NOT allowed, and must be rejected just like an explicit private would be.
    const cfgNoPrivate = cfg({ CANVAS_DROP_AUTHORING_ALLOWED_RUNGS: "public_link" });
    const { app } = buildApi(client, asMember(owner.id), cfgNoPrivate);
    const res = await publish(app, publishBody({ title: "S" })); // no access field
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_BODY");
  });

  it("update enforces requireExpiry on the resulting shareable state", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const cfgReq = cfg({ CANVAS_DROP_AUTHORING_REQUIRE_EXPIRY: "true" });
    const { app } = buildApi(client, asMember(owner.id), cfgReq);
    // A private share needs no expiry; flipping it to public_link with none must be refused.
    const pub = (await (
      await publish(app, publishBody({ title: "S", access: "private" }))
    ).json()) as AuthoredCanvas;
    const noExpiry = await putUpdate(app, pub.id, formData({ access: "public_link" }));
    expect(noExpiry.status).toBe(400);
    // With an expiry it succeeds.
    const withExpiry = await putUpdate(
      app,
      pub.id,
      formData({ access: "public_link", expiresAt: Date.now() + 864e5 }),
    );
    expect(withExpiry.status).toBe(200);
    // Clearing the expiry back off a shareable share is refused too.
    const cleared = await putUpdate(app, pub.id, formData({ expiresAt: null }));
    expect(cleared.status).toBe(400);
  });

  it("update clearing a password on a public_link share re-runs the public-link admin gate", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    // Create a password-protected public link as an account allowed to publish public links.
    const pub = (await (
      await publish(
        buildApi(client, asMember(owner.id)).app,
        publishBody({ title: "S", access: "password", password: "hunter2" }),
      )
    ).json()) as AuthoredCanvas;
    // Now that account loses the grant; clearing the password would make it an OPEN public
    // link — the exposure-widening op must re-hit the gate even though access is unchanged.
    const revokedApp = buildApi(client, asMember(owner.id, { canPublishPublic: false })).app;
    const res = await putUpdate(revokedApp, pub.id, formData({ password: null }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("PUBLIC_NOT_ALLOWED");
  });

  it("update on a revoked share is rejected (SHARE_REVOKED)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const { app } = buildApi(client, asMember(owner.id));
    const pub = (await (
      await publish(app, publishBody({ title: "S", access: "private" }))
    ).json()) as AuthoredCanvas;
    await app.request(`/v1/c/app/authoring/${pub.id}`, { method: "DELETE" });
    const res = await putUpdate(app, pub.id, formData({ title: "S2" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("SHARE_REVOKED");
  });

  it("update on another owner's share is 404 (no leak)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const other = await seedUser(client, "other");
    const otherCanvas = await canvasesRepository(client).create({
      ownerId: other.id,
      slug: "other",
      apiKeyHash: "h-o",
    });
    const { app } = buildApi(client, asMember(owner.id));
    const res = await putUpdate(app, otherCanvas.id, formData({ title: "hax" }));
    expect(res.status).toBe(404);
  });

  it("update + revoke are refused on an admin-disabled share (§12.0 #5 — no self-rescue)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const canvases = canvasesRepository(client);
    const { app } = buildApi(client, asMember(owner.id));
    const pub = (await (
      await publish(app, publishBody({ title: "S", access: "private" }))
    ).json()) as AuthoredCanvas;
    await canvases.setStatus(pub.id, "disabled"); // admin takedown

    const upd = await putUpdate(
      app,
      pub.id,
      formData({}, zipFile({ "index.html": "<h1>rescue</h1>" })),
    );
    expect(upd.status).toBe(409);
    expect(((await upd.json()) as { code: string }).code).toBe("DISABLED");

    const rev = await app.request(`/v1/c/app/authoring/${pub.id}`, { method: "DELETE" });
    expect(rev.status).toBe(409);
    // The owner could not re-deploy or flip the taken-down canvas.
    expect((await canvases.findById(pub.id))?.status).toBe("disabled");
  });

  it("metadata round-trips on publish + list; sourceApp/sourceKind surfaced; filter works (AE2)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const { app } = buildApi(client, asMember(owner.id));
    await publish(
      app,
      publishBody({
        title: "Roadmap",
        access: "private",
        tags: ["q3"],
        metadata: { sourceApp: "product-roadmap", sourceKind: "roadmap-share", itemCount: 5 },
      }),
    );
    await publish(
      app,
      publishBody({ title: "Other", access: "private", metadata: { sourceApp: "other-app" } }),
    );

    const all = (await (await app.request("/v1/c/app/authoring", { method: "GET" })).json()) as {
      canvases: AuthoredCanvas[];
    };
    expect(all.canvases.length).toBe(2);
    const roadmap = all.canvases.find((s) => s.sourceApp === "product-roadmap");
    expect(roadmap?.metadata).toMatchObject({ sourceKind: "roadmap-share", itemCount: 5 });

    const filtered = (await (
      await app.request("/v1/c/app/authoring?sourceApp=product-roadmap", { method: "GET" })
    ).json()) as { canvases: AuthoredCanvas[] };
    expect(filtered.canvases.map((s) => s.sourceApp)).toEqual(["product-roadmap"]);
  });

  it("revoked + expired shares stay listed with the right status (AE3/AE4)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await makeSource(client);
    const { app } = buildApi(client, asMember(owner.id));
    const canvases = canvasesRepository(client);

    const live = (await (
      await publish(app, publishBody({ title: "Live", access: "private" }))
    ).json()) as AuthoredCanvas;
    const rev = (await (
      await publish(app, publishBody({ title: "Rev", access: "private" }))
    ).json()) as AuthoredCanvas;
    const exp = (await (
      await publish(app, publishBody({ title: "Exp", access: "public_link" }))
    ).json()) as AuthoredCanvas;

    await app.request(`/v1/c/app/authoring/${rev.id}`, { method: "DELETE" }); // revoke
    await canvases.updateSettings(exp.id, { sharedExpiresAt: Date.now() - 1000 }); // force expired

    const list = (await (await app.request("/v1/c/app/authoring", { method: "GET" })).json()) as {
      canvases: AuthoredCanvas[];
    };
    const byId = Object.fromEntries(list.canvases.map((s) => [s.id, s.status]));
    expect(byId[live.id]).toBe("private");
    expect(byId[rev.id]).toBe("revoked"); // still listed (AE3)
    expect(byId[exp.id]).toBe("expired"); // still listed (AE4)
  });
});

// --- Editor role on the authoring management routes (editor-roles plan U3, KTD12) ------

describe("canvasAuthoringRoutes — editor role (admin allowance retained)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seedShare() {
    client = await makeTestDb("sqlite");
    const { owner, cv: source } = await makeSource(client);
    // The authoring API is called from source canvas A's origin, so every actor must be
    // able to REACH A (the canvas-api access gate runs first): open A to the org.
    await canvasesRepository(client).setAccess(source.id, "whole_org");
    const editor = await seedUser(client, "editor");
    const nobody = await seedUser(client, "nobody");
    const admin = await seedUser(client, "admin", true);
    const { app: ownerApp } = buildApi(client, asMember(owner.id));
    const pub = (await (
      await publish(ownerApp, publishBody({ title: "S", access: "private" }))
    ).json()) as AuthoredCanvas;
    await canvasesRepository(client).addAllowlistEntry({
      canvasId: pub.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    return { owner, editor, nobody, admin, pub };
  }

  it("PUT /:id: an editor updates the share; an admin is still allowed (KTD12); a no-role member is 404", async () => {
    const { editor, nobody, admin, pub } = await seedShare();
    const asEditor = buildApi(client, asMember(editor.id)).app;
    const upd = await putUpdate(asEditor, pub.id, formData({ title: "by editor" }));
    expect(upd.status).toBe(200);
    const asAdmin = buildApi(client, asMember(admin.id, { isAdmin: true })).app;
    expect((await putUpdate(asAdmin, pub.id, formData({ title: "by admin" }))).status).toBe(200);
    const asNobody = buildApi(client, asMember(nobody.id)).app;
    expect((await putUpdate(asNobody, pub.id, formData({ title: "hax" }))).status).toBe(404);
  });

  it("DELETE /:id (revoke): editor 204; no-role member 404 with the share untouched", async () => {
    const { editor, nobody, pub } = await seedShare();
    const asNobody = buildApi(client, asMember(nobody.id)).app;
    expect(
      (await asNobody.request(`/v1/c/app/authoring/${pub.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect((await canvasesRepository(client).findById(pub.id))?.revokedAt).toBeNull();
    const asEditor = buildApi(client, asMember(editor.id)).app;
    expect(
      (await asEditor.request(`/v1/c/app/authoring/${pub.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await canvasesRepository(client).findById(pub.id))?.revokedAt).not.toBeNull();
  });
});

import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { pino } from "pino";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import { guestService } from "../auth/guest.js";
import { cloneService } from "../canvas/clone-service.js";
import { verifyPassword } from "../canvas/password.js";
import { SCREENSHOT_RENDITIONS, screenshotKey } from "../canvas/storage-keys.js";
import { versionHistoryService } from "../canvas/version-history.js";
import type { DbClient } from "../db/factory.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { allowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { filesRepository } from "../db/repositories/files.js";
import { guestRepository } from "../db/repositories/guest.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { screenshotsRepository } from "../db/repositories/screenshots.js";
import { hashToken } from "../db/repositories/sessions.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import type { DeployEntry } from "../deploy/ingest.js";
import type { AppEnv } from "../http/types.js";
import { makeInviteService } from "../invites/testing.js";
import { memStorage } from "../storage/mem.js";
import { managementRoutes } from "./management.js";
import { meRoutes } from "./me.js";

/** A small valid PNG for the custom-preview upload tests. */
async function pngBytes(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

const silent = pino({ level: "silent" });
const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Build a management app that authenticates as a chosen user (no gateway needed). */
function buildApp(
  client: DbClient,
  actor: { id: string; isAdmin: boolean; canPublishPublic?: boolean; orgIds?: Set<string> },
  storage = memStorage(),
  // biome-ignore lint/suspicious/noExplicitAny: optional spy hub for revoke-hook tests
  hub?: any,
  // When false, simulate proxy mode (no legacy guest service wired).
  withGuests = true,
  // Screenshot preview pipeline effective-enabled (plan 004); off by default so
  // existing tests see hasPreview=false (today's behavior).
  screenshotsEnabled = false,
  // Override the screenshots repo (e.g. a throwing stub for the degradation test).
  screenshots: Pick<
    ReturnType<typeof screenshotsRepository>,
    "doneCanvasIds"
  > = screenshotsRepository(client),
  cfg: Config = config,
) {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const audit = createAuditLog(auditRepository(client), silent);
  const engine = deployEngine({ config: cfg, canvases, versions, drafts, storage, log: silent });
  const clone = cloneService({ canvases, versions, drafts, storage });
  const versionHistory = versionHistoryService({ versions, storage, engine, audit });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    // stand in for the foundation gateway: inject the authenticated user
    c.set("user", {
      id: actor.id,
      isAdmin: actor.isAdmin,
      name: "Actor",
      email: `${actor.id}@example.com`,
      canPublishPublic: (actor as { canPublishPublic?: boolean }).canPublishPublic ?? true,
    } as never);
    c.set("orgIds", actor.orgIds ?? new Set<string>());
    c.set("clientIp", "127.0.0.1");
    await next();
  });
  app.route(
    "/api/me",
    meRoutes({
      authMode: "dev",
      urlMode: "path",
      baseUrl: "http://localhost:8787",
      designSkin: async () => "editorial",
      publicLinksEnabled: async () => true,
      orgs: { findById: async () => null },
      tenancyActive: false,
    }),
  );
  app.route(
    "/api/canvases",
    managementRoutes({
      config: cfg,
      canvases,
      users: usersRepository(client),
      versions,
      clone,
      audit,
      engine,
      versionHistory,
      storage,
      usage: usageEventsRepository(client),
      files: filesRepository(client),
      aiUsage: aiUsageRepository(client),
      hub,
      guests: withGuests ? guestService(config, guestRepository(client)) : undefined,
      invites: makeInviteService(client, cfg),
      invitations: invitationsRepository(client),
      publicLinksEnabled: () => Promise.resolve(true),
      screenshotsEnabled: () => Promise.resolve(screenshotsEnabled),
      screenshots,
      teams: teamsRepository(client),
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

  it("GET /?sort=popular ranks by recent views and reports recentViews per row (plan 004)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const usage = usageEventsRepository(client);
    const hot = await repo.create({ ownerId: owner.id, slug: "hot", apiKeyHash: "kh" });
    const cold = await repo.create({ ownerId: owner.id, slug: "cold", apiKeyHash: "kc" });
    const now = Date.now();
    // hot: two distinct recent viewers; cold: none. (guest ids have no FK on userId.)
    await usage.recordView({ canvasId: hot.id, userId: owner.id, windowMs: 60_000, now });
    await usage.recordView({ canvasId: hot.id, userId: "guest:x", windowMs: 60_000, now: now + 1 });

    const res = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      "/api/canvases?sort=popular",
    );
    expect(res.status).toBe(200);
    const body = await jsonOf<{ canvases: Array<{ id: string; recentViews: number }> }>(res);
    expect(body.canvases.map((cv) => cv.id)).toEqual([hot.id, cold.id]);
    expect(body.canvases.find((cv) => cv.id === hot.id)?.recentViews).toBe(2);
    expect(body.canvases.find((cv) => cv.id === cold.id)?.recentViews).toBe(0);
  });

  it("GET /?tag= filters the owner list (single match, multi-tag any-match)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const charts = await repo.create({ ownerId: owner.id, slug: "charts", apiKeyHash: "kc" });
    const finance = await repo.create({ ownerId: owner.id, slug: "finance", apiKeyHash: "kf" });
    await repo.updateSettings(charts.id, { tags: ["charts"] });
    await repo.updateSettings(finance.id, { tags: ["finance"] });

    const app = () => buildApp(client, { id: owner.id, isAdmin: false });

    // A single tag returns only the matching canvas.
    const one = await jsonOf<{ canvases: Array<{ id: string }> }>(
      await app().request("/api/canvases?tag=charts"),
    );
    expect(one.canvases.map((cv) => cv.id)).toEqual([charts.id]);

    // Repeated ?tag=a&tag=b is any-match → both canvases.
    const both = await jsonOf<{ canvases: Array<{ id: string }> }>(
      await app().request("/api/canvases?tag=charts&tag=finance"),
    );
    expect(new Set(both.canvases.map((cv) => cv.id))).toEqual(new Set([charts.id, finance.id]));
  });

  it("GET /tags returns the owner's distinct tags (deduped, sorted), owner-scoped", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const repo = canvasesRepository(client);
    const a = await repo.create({ ownerId: owner.id, slug: "a", apiKeyHash: "ka" });
    const b = await repo.create({ ownerId: owner.id, slug: "b", apiKeyHash: "kb" });
    const stranger = await repo.create({ ownerId: other.id, slug: "s", apiKeyHash: "ks" });
    // Overlap across the owner's own canvases dedupes; "zebra" sorts after "charts".
    await repo.updateSettings(a.id, { tags: ["zebra", "charts"] });
    await repo.updateSettings(b.id, { tags: ["charts", "finance"] });
    // A different owner's tag must NOT leak into the caller's vocabulary (§12).
    await repo.updateSettings(stranger.id, { tags: ["secret-other-owner-tag"] });

    const res = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      "/api/canvases/tags",
    );
    expect(res.status).toBe(200);
    const body = await jsonOf<{ tags: string[] }>(res);
    // Distinct + sorted; no duplicate "charts"; no other owner's tag.
    expect(body.tags).toEqual(["charts", "finance", "zebra"]);
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

  it("GET /by-slug/:slug resolves an owner's slug to its id, 404 for non-owner/unknown (U17)", async () => {
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

    // Owner: resolves to the canonical id (and nothing else leaks).
    const asOwner = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      `/api/canvases/by-slug/${created.slug}`,
    );
    expect(asOwner.status).toBe(200);
    const body = await jsonOf<Record<string, unknown>>(asOwner);
    expect(body).toEqual({ id: created.id });

    // Non-owner: 404, no existence leak (same posture as GET /:id).
    const asOther = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/by-slug/${created.slug}`,
    );
    expect(asOther.status).toBe(404);

    // Unknown slug: 404 for the owner too.
    const unknown = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      "/api/canvases/by-slug/no-such-slug",
    );
    expect(unknown.status).toBe(404);
  });

  it("hasPreview reflects a captured preview only when the pipeline is enabled (plan 004)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const created = await jsonOf<{ id: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    // Capture a preview for the canvas (a done screenshot job).
    const jobs = screenshotsRepository(client);
    await jobs.enqueue(created.id, "v-1");
    const claimed = await jobs.claimNext(Date.now(), Date.now() - 30_000);
    if (claimed) await jobs.markDone(claimed.id, claimed.leasedAt as number);

    // Pipeline OFF (default) → hasPreview false even though a preview exists.
    const off = await jsonOf<{ hasPreview: boolean }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request(
        `/api/canvases/${created.id}`,
      ),
    );
    expect(off.hasPreview).toBe(false);

    // Pipeline ON → hasPreview true, on BOTH the single-canvas (canvasView) and the
    // list (withLastDeploy → batched previewIds) paths.
    const appOn = () =>
      buildApp(client, { id: owner.id, isAdmin: false }, undefined, undefined, true, true);
    const on = await jsonOf<{ hasPreview: boolean }>(
      await appOn().request(`/api/canvases/${created.id}`),
    );
    expect(on.hasPreview).toBe(true);

    const list = await jsonOf<{ canvases: { id: string; hasPreview: boolean }[] }>(
      await appOn().request("/api/canvases"),
    );
    expect(list.canvases.find((c) => c.id === created.id)?.hasPreview).toBe(true);
  });

  it("a failing preview lookup degrades to hasPreview=false, never 500s the canvas API", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const created = await jsonOf<{ id: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    // Pipeline ON but the (cosmetic) screenshot lookup throws — the primary canvas
    // management API must still answer 200 with hasPreview=false, not propagate a 500.
    const throwing = {
      doneCanvasIds: () => Promise.reject(new Error("screenshot db down")),
    };
    const res = await buildApp(
      client,
      { id: owner.id, isAdmin: false },
      undefined,
      undefined,
      true,
      true,
      throwing,
    ).request(`/api/canvases/${created.id}`);
    expect(res.status).toBe(200);
    expect((await jsonOf<{ hasPreview: boolean }>(res)).hasPreview).toBe(false);
  });

  it("PUT/DELETE /:id/preview sets a custom cover (survives publish-off pipeline) and clears it", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const storage = memStorage();
    const app = () => buildApp(client, { id: owner.id, isAdmin: false }, storage);
    const created = await jsonOf<{ id: string }>(
      await app().request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );

    // Upload a custom image → previewMode=custom, renditions written to storage.
    const put = await app().request(`/api/canvases/${created.id}/preview`, {
      method: "PUT",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "image/png" },
      body: await pngBytes(),
    });
    expect(put.status).toBe(200);
    expect((await jsonOf<{ previewMode: string }>(put)).previewMode).toBe("custom");
    for (const rendition of SCREENSHOT_RENDITIONS) {
      expect(await storage.exists(screenshotKey(created.id, rendition))).toBe(true);
    }

    // hasPreview is true even with the screenshot pipeline OFF — a custom cover does
    // not depend on the capture pipeline (previewVisible short-circuits on "custom").
    const view = await jsonOf<{ hasPreview: boolean; previewMode: string }>(
      await app().request(`/api/canvases/${created.id}`),
    );
    expect(view.hasPreview).toBe(true);
    expect(view.previewMode).toBe("custom");

    // Clearing reverts to auto and removes the stored renditions.
    const del = await app().request(`/api/canvases/${created.id}/preview`, {
      method: "DELETE",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(del.status).toBe(200);
    expect((await jsonOf<{ previewMode: string }>(del)).previewMode).toBe("auto");
    for (const rendition of SCREENSHOT_RENDITIONS) {
      expect(await storage.exists(screenshotKey(created.id, rendition))).toBe(false);
    }
  });

  it("DELETE /:id/preview is a no-op on a non-custom canvas — never deletes an auto screenshot", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const storage = memStorage();
    const created = await jsonOf<{ id: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }, storage).request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    // Simulate an auto-captured screenshot already on disk (previewMode stays "auto").
    for (const rendition of SCREENSHOT_RENDITIONS) {
      await storage.put(screenshotKey(created.id, rendition), new Uint8Array([1]), {
        contentType: "image/webp",
      });
    }

    const del = await buildApp(client, { id: owner.id, isAdmin: false }, storage).request(
      `/api/canvases/${created.id}/preview`,
      { method: "DELETE", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(del.status).toBe(200);
    expect((await jsonOf<{ previewMode: string }>(del)).previewMode).toBe("auto");
    // The auto-captured renditions must survive — DELETE only clears a custom upload.
    for (const rendition of SCREENSHOT_RENDITIONS) {
      expect(await storage.exists(screenshotKey(created.id, rendition))).toBe(true);
    }
  });

  it("PATCH /:id/settings previewMode:auto from custom drops the orphaned custom renditions", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const storage = memStorage();
    const app = () => buildApp(client, { id: owner.id, isAdmin: false }, storage);
    const created = await jsonOf<{ id: string }>(
      await app().request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    await app().request(`/api/canvases/${created.id}/preview`, {
      method: "PUT",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "image/png" },
      body: await pngBytes(),
    });

    // Switching back to auto through the settings API (not the dedicated DELETE) must
    // still clean up the custom renditions so they aren't served stale under "auto".
    const patch = await app().request(`/api/canvases/${created.id}/settings`, {
      method: "PATCH",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ previewMode: "auto" }),
    });
    expect(patch.status).toBe(200);
    expect((await jsonOf<{ previewMode: string }>(patch)).previewMode).toBe("auto");
    for (const rendition of SCREENSHOT_RENDITIONS) {
      expect(await storage.exists(screenshotKey(created.id, rendition))).toBe(false);
    }
  });

  it("PUT /:id/preview rejects a non-image body (400) and a non-owner (404, no leak)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const stranger = await seedUser(client, "stranger");
    const created = await jsonOf<{ id: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );

    const notImage = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/preview`,
      {
        method: "PUT",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "image/png" },
        body: new Uint8Array([1, 2, 3, 4]),
      },
    );
    expect(notImage.status).toBe(400);

    const asStranger = await buildApp(client, { id: stranger.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/preview`,
      {
        method: "PUT",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "image/png" },
        body: await pngBytes(),
      },
    );
    expect(asStranger.status).toBe(404);
  });

  it("GET /:id derives publicationState across draft/published/archived/disabled (R6)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = () => buildApp(client, { id: owner.id, isAdmin: false });
    const repo = canvasesRepository(client);
    const stateOf = async (id: string) =>
      (await jsonOf<{ publicationState: string }>(await app().request(`/api/canvases/${id}`)))
        .publicationState;

    // Fresh canvas, never published → draft.
    const draft = await jsonOf<{ id: string }>(
      await app().request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(await stateOf(draft.id)).toBe("draft");

    // Created-and-published via paste → published.
    const published = await jsonOf<{ id: string }>(
      await app().request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>hi</h1>" }),
      }),
    );
    expect(await stateOf(published.id)).toBe("published");

    // Archive outranks published.
    await repo.archive(published.id);
    expect(await stateOf(published.id)).toBe("archived");

    // Disable outranks everything (admin takedown of the still-draft canvas).
    await repo.setDisabled(draft.id, "abuse");
    expect(await stateOf(draft.id)).toBe("disabled");
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
    // An admin has no owner access to someone else's canvas: the management DELETE
    // route 404s for a non-owner admin (it must be re-enabled, then the owner deletes).
    const asAdmin = await buildApp(client, { id: "admin", isAdmin: true }).request(
      `/api/canvases/${created.id}`,
      { method: "DELETE", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(asAdmin.status).toBe(404);
    expect((await canvasesRepository(client).findById(created.id))?.status).toBe("disabled");
  });

  describe("a disabled canvas is READ-ONLY to its owner (admin takedown)", () => {
    async function seedDisabled(reason = "policy violation") {
      client = await makeTestDb("sqlite");
      const owner = await seedUser(client, "owner");
      const created = await jsonOf<{ id: string }>(
        await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases", {
          method: "POST",
          headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
          body: "{}",
        }),
      );
      await canvasesRepository(client).setDisabled(created.id, reason);
      return { owner, id: created.id };
    }
    const so = { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" } as const;

    it("rejects every owner MUTATION with a consistent DISABLED 409 carrying the reason", async () => {
      const { owner, id } = await seedDisabled("policy violation");
      const app = () => buildApp(client, { id: owner.id, isAdmin: false });
      // [method, path, body?] for each owner-mutation route.
      const cases: Array<[string, string, unknown?]> = [
        ["PATCH", `/api/canvases/${id}/settings`, { title: "new" }],
        ["PATCH", `/api/canvases/${id}/capabilities`, { kv: false }],
        ["POST", `/api/canvases/${id}/regenerate-slug`, {}],
        ["POST", `/api/canvases/${id}/regenerate-key`, {}],
        ["POST", `/api/canvases/${id}/allowlist`, { email: "guest@example.com" }],
        ["DELETE", `/api/canvases/${id}/preview`, undefined],
        ["POST", `/api/canvases/${id}/archive`, {}],
        ["POST", `/api/canvases/${id}/unarchive`, {}],
        ["POST", `/api/canvases/${id}/unpublish`, {}],
        ["POST", `/api/canvases/${id}/rollback`, { version: 1 }],
        ["DELETE", `/api/canvases/${id}/versions/1`, undefined],
        ["DELETE", `/api/canvases/${id}`, undefined],
      ];
      for (const [method, path, body] of cases) {
        const res = await app().request(path, {
          method,
          headers: so,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(res.status, `${method} ${path}`).toBe(409);
        const j = await jsonOf<{ code: string; message: string }>(res);
        expect(j.code, `${method} ${path}`).toBe("DISABLED");
        expect(j.message).toMatch(/disabled by an administrator/i);
        expect(j.message).toContain("policy violation"); // the reason is surfaced
      }
      // The canvas was never mutated — still disabled, title unchanged.
      expect((await canvasesRepository(client).findById(id))?.status).toBe("disabled");
    });

    it("still allows READS so the owner can see the canvas + takedown reason", async () => {
      const { owner, id } = await seedDisabled("internal review");
      const app = () => buildApp(client, { id: owner.id, isAdmin: false });
      const detail = await app().request(`/api/canvases/${id}`);
      expect(detail.status).toBe(200);
      expect((await jsonOf<{ disabledReason: string }>(detail)).disabledReason).toBe(
        "internal review",
      );
      expect((await app().request(`/api/canvases/${id}/versions`)).status).toBe(200);
      expect((await app().request(`/api/canvases/${id}/usage`)).status).toBe(200);
      expect((await app().request(`/api/canvases/${id}/allowlist`)).status).toBe(200);
      expect((await app().request("/api/canvases")).status).toBe(200);
    });

    it("does NOT gate an ARCHIVED canvas — owner edits still work (regression guard)", async () => {
      client = await makeTestDb("sqlite");
      const owner = await seedUser(client, "owner");
      const repo = canvasesRepository(client);
      const cv = await repo.create({ ownerId: owner.id, slug: "arch", apiKeyHash: "kh" });
      await repo.archive(cv.id);
      const app = () => buildApp(client, { id: owner.id, isAdmin: false });
      // Settings + capabilities succeed on an archived canvas (200, not 409 DISABLED).
      const settings = await app().request(`/api/canvases/${cv.id}/settings`, {
        method: "PATCH",
        headers: so,
        body: JSON.stringify({ title: "renamed while archived" }),
      });
      expect(settings.status).toBe(200);
      const caps = await app().request(`/api/canvases/${cv.id}/capabilities`, {
        method: "PATCH",
        headers: so,
        body: JSON.stringify({ kv: false }),
      });
      expect(caps.status).toBe(200);
      expect((await repo.findById(cv.id))?.title).toBe("renamed while archived");
    });
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

  it("an admin CANNOT read another user's canvas via the owner management route (404)", async () => {
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
    // Owner management is owner-only — an admin is treated like any other member here
    // (no existence leak). Cross-owner admin power lives on the admin routes only.
    const res = await buildApp(client, { id: admin.id, isAdmin: true }).request(
      `/api/canvases/${created.id}`,
    );
    expect(res.status).toBe(404);
    // …but the owner still reaches it (the owner check, not isAdmin, is the gate).
    const asOwner = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      `/api/canvases/${created.id}`,
    );
    expect(asOwner.status).toBe(200);
  });

  it("settings: shared toggle, password set (argon2id hash) and clear", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    // Create published (sharing requires Published — invariant: shared ⟹ published).
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>hi</h1>" }),
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

  it("settings: restricting a public_link canvas returns a CDN edge-cache warning", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false, canPublishPublic: true });
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>hi</h1>" }),
      }),
    );
    // Make it anonymously public, then restrict it back to private.
    await app.request(`/api/canvases/${created.id}/settings`, {
      method: "PATCH",
      headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ access: "public_link" }),
    });
    const restricted = await jsonOf<{ warning?: string }>(
      await app.request(`/api/canvases/${created.id}/settings`, {
        method: "PATCH",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ access: "private" }),
      }),
    );
    expect(restricted.warning).toMatch(/CDN/);

    // A non-downgrade edit carries no warning.
    const renamed = await jsonOf<{ warning?: string }>(
      await app.request(`/api/canvases/${created.id}/settings`, {
        method: "PATCH",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      }),
    );
    expect(renamed.warning).toBeUndefined();
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

  describe("custom slugs (plan 004)", () => {
    const hdrs = { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" };

    async function post(app: ReturnType<typeof buildApp>, path: string, body: unknown) {
      return app.request(path, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
    }

    it("create accepts a valid custom slug and marks it custom", async () => {
      client = await makeTestDb("sqlite");
      const owner = await seedUser(client, "owner");
      const app = buildApp(client, { id: owner.id, isAdmin: false });
      const res = await post(app, "/api/canvases", { slug: "team-dashboard" });
      expect(res.status).toBe(201);
      const body = await jsonOf<{ slug: string; slugCustom: boolean; url: string }>(res);
      expect(body.slug).toBe("team-dashboard");
      expect(body.slugCustom).toBe(true);
      expect(body.url).toContain("team-dashboard");
    });

    it("create with no slug stays random and not custom", async () => {
      client = await makeTestDb("sqlite");
      const owner = await seedUser(client, "owner");
      const app = buildApp(client, { id: owner.id, isAdmin: false });
      const body = await jsonOf<{ slug: string; slugCustom: boolean }>(
        await post(app, "/api/canvases", {}),
      );
      expect(body.slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{13}$/);
      expect(body.slugCustom).toBe(false);
    });

    it("create rejects invalid and reserved slugs with 400", async () => {
      client = await makeTestDb("sqlite");
      const owner = await seedUser(client, "owner");
      const app = buildApp(client, { id: owner.id, isAdmin: false });
      for (const slug of ["UPPER", "-bad", "has space", "mcp", "api"]) {
        const res = await post(app, "/api/canvases", { slug });
        expect(res.status, slug).toBe(400);
      }
    });

    // Run the 409 catch path on BOTH dialects: it exercises isUniqueViolation against
    // the real driver error, whose shape differs (better-sqlite3 vs pglite-under-.cause).
    // The rest of this suite is sqlite-only by design (see file header); this case
    // specifically guards the dialect-aware catch in the route (KTD7).
    it.each(DIALECTS)(
      "create returns 409 when the custom slug is already taken [%s]",
      async (dialect) => {
        client = await makeTestDb(dialect);
        const owner = await seedUser(client, "owner");
        const app = buildApp(client, { id: owner.id, isAdmin: false });
        expect((await post(app, "/api/canvases", { slug: "taken-one" })).status).toBe(201);
        const dup = await post(app, "/api/canvases", { slug: "taken-one" });
        expect(dup.status).toBe(409);
        expect((await jsonOf<{ error: string }>(dup)).error).toBe("slug_taken");
      },
    );

    it("paste accepts a custom slug; a taken slug 409s and leaves no orphan", async () => {
      client = await makeTestDb("sqlite");
      const owner = await seedUser(client, "owner");
      const app = buildApp(client, { id: owner.id, isAdmin: false });
      const ok = await post(app, "/api/canvases/paste", {
        html: "<h1>hi</h1>",
        slug: "pasted-site",
      });
      expect(ok.status).toBe(201);
      expect((await jsonOf<{ slugCustom: boolean }>(ok)).slugCustom).toBe(true);
      // Re-paste with the same slug: the create() throws before any row exists.
      const dup = await post(app, "/api/canvases/paste", {
        html: "<h1>again</h1>",
        slug: "pasted-site",
      });
      expect(dup.status).toBe(409);
      // No orphan: exactly one canvas holds the slug.
      expect((await canvasesRepository(client).findBySlug("pasted-site")) !== null).toBe(true);
      const list = await canvasesRepository(client).listByOwnerFiltered({
        ownerId: owner.id,
        limit: 100,
        offset: 0,
      });
      expect(list.items.filter((c) => c.slug === "pasted-site").length).toBe(1);
    });

    it("regenerate-slug sets a custom slug, or a random one when empty", async () => {
      client = await makeTestDb("sqlite");
      const owner = await seedUser(client, "owner");
      const app = buildApp(client, { id: owner.id, isAdmin: false });
      const created = await jsonOf<{ id: string; slug: string }>(
        await post(app, "/api/canvases", {}),
      );
      const renamed = await jsonOf<{ slug: string; slugCustom: boolean }>(
        await post(app, `/api/canvases/${created.id}/regenerate-slug`, { slug: "renamed-canvas" }),
      );
      expect(renamed.slug).toBe("renamed-canvas");
      expect(renamed.slugCustom).toBe(true);
      // Old slug no longer resolves; new one does.
      expect(await canvasesRepository(client).findBySlug(created.slug)).toBeNull();
      expect((await canvasesRepository(client).findBySlug("renamed-canvas"))?.id).toBe(created.id);
      // Empty body → random, not custom.
      const back = await jsonOf<{ slug: string; slugCustom: boolean }>(
        await post(app, `/api/canvases/${created.id}/regenerate-slug`, {}),
      );
      expect(back.slugCustom).toBe(false);
    });

    it("regenerate-slug rejects invalid (400) and taken (409) custom slugs", async () => {
      client = await makeTestDb("sqlite");
      const owner = await seedUser(client, "owner");
      const app = buildApp(client, { id: owner.id, isAdmin: false });
      await post(app, "/api/canvases", { slug: "occupied" });
      const target = await jsonOf<{ id: string }>(await post(app, "/api/canvases", {}));
      expect(
        (await post(app, `/api/canvases/${target.id}/regenerate-slug`, { slug: "API" })).status,
      ).toBe(400);
      const taken = await post(app, `/api/canvases/${target.id}/regenerate-slug`, {
        slug: "occupied",
      });
      expect(taken.status).toBe(409);
    });

    it("GET /slug-available reports availability and never shadows /:id", async () => {
      client = await makeTestDb("sqlite");
      const owner = await seedUser(client, "owner");
      const app = buildApp(client, { id: owner.id, isAdmin: false });
      await post(app, "/api/canvases", { slug: "is-taken" });
      const check = async (slug: string) =>
        jsonOf<{ available: boolean; reason?: string }>(
          await app.request(`/api/canvases/slug-available?slug=${encodeURIComponent(slug)}`),
        );
      expect(await check("wide-open")).toEqual({ available: true });
      expect(await check("is-taken")).toEqual({ available: false, reason: "taken" });
      expect(await check("UPPER")).toEqual({ available: false, reason: "invalid" });
      expect(await check("mcp")).toEqual({ available: false, reason: "reserved" });
      // The literal `slug-available` segment resolves to this handler, not GET /:id.
      const raw = await app.request("/api/canvases/slug-available?slug=anything");
      expect(raw.status).toBe(200);
    });

    it("a slug freed only by soft-delete still reports taken (agrees with the index)", async () => {
      client = await makeTestDb("sqlite");
      const owner = await seedUser(client, "owner");
      const app = buildApp(client, { id: owner.id, isAdmin: false });
      const cv = await jsonOf<{ id: string }>(await post(app, "/api/canvases", { slug: "ghost" }));
      await app.request(`/api/canvases/${cv.id}`, {
        method: "DELETE",
        headers: { "Sec-Fetch-Site": "same-origin" },
      });
      const body = await jsonOf<{ available: boolean; reason?: string }>(
        await app.request("/api/canvases/slug-available?slug=ghost"),
      );
      expect(body).toEqual({ available: false, reason: "taken" });
    });
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

    // The Active/Archived toggle reads the list endpoint with `?scope=archived`.
    const scoped = await jsonOf<{ canvases: { id: string }[]; total: number }>(
      await app.request("/api/canvases?scope=archived"),
    );
    expect(scoped.canvases.map((c) => c.id)).toEqual([created.id]);
    expect(scoped.total).toBe(1);
  });

  it("unpublish takes a published canvas to Draft and clears its gallery listing", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    // Create + publish via paste, then share and list it in the gallery.
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>hi</h1>" }),
      }),
    );
    const patch = (body: unknown) =>
      app.request(`/api/canvases/${created.id}/settings`, {
        method: "PATCH",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await patch({ shared: true });
    await patch({ discoverability: "listed", galleryListed: true });

    const res = await app.request(`/api/canvases/${created.id}/unpublish`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(200);
    const view = await jsonOf<{
      publicationState: string;
      accessMode: string;
      currentVersionId: string | null;
      shared: boolean;
      galleryListed: boolean;
    }>(res);
    expect(view.publicationState).toBe("draft");
    expect(view.accessMode).toBe("restricted"); // audience rides alongside lifecycle
    expect(view.currentVersionId).toBeNull();
    expect(view.shared).toBe(false); // leaving Published reverts share
    expect(view.galleryListed).toBe(false);
    // Still in the owner's active list (Draft, not archived).
    const active = await jsonOf<{ canvases: { id: string }[] }>(await app.request("/api/canvases"));
    expect(active.canvases.map((c) => c.id)).toContain(created.id);
  });

  it("unpublish on a Draft canvas → 409 CANNOT_UNPUBLISH; a non-owner → 404", async () => {
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
    const onDraft = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/unpublish`,
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(onDraft.status).toBe(409);
    expect((await jsonOf<{ code: string }>(onDraft)).code).toBe("CANNOT_UNPUBLISH");

    const asOther = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/unpublish`,
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(asOther.status).toBe(404);
  });

  it("share requires Published: PATCH shared=true 409s on a Draft, succeeds on a Published canvas", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const patch = (id: string, body: unknown) =>
      app.request(`/api/canvases/${id}/settings`, {
        method: "PATCH",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Draft (never published) → sharing is rejected.
    const draft = await jsonOf<{ id: string }>(
      await app.request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const denied = await patch(draft.id, { shared: true });
    expect(denied.status).toBe(409);
    expect((await jsonOf<{ code: string }>(denied)).code).toBe("SHARE_REQUIRES_PUBLISH");

    // Published → sharing is allowed.
    const pub = await jsonOf<{ id: string }>(
      await app.request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>hi</h1>" }),
      }),
    );
    const ok = await patch(pub.id, { shared: true });
    expect(ok.status).toBe(200);
    expect((await jsonOf<{ shared: boolean }>(ok)).shared).toBe(true);
  });

  it("unpublish requires same-origin (cross-site → 403)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>hi</h1>" }),
      }),
    );
    const res = await app.request(`/api/canvases/${created.id}/unpublish`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("archive clears shared + gallery in the returned view (leaving Published)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>hi</h1>" }),
      }),
    );
    const patch = (body: unknown) =>
      app.request(`/api/canvases/${created.id}/settings`, {
        method: "PATCH",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await patch({ shared: true });
    await patch({ discoverability: "listed", galleryListed: true });
    const res = await app.request(`/api/canvases/${created.id}/archive`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(200);
    const view = await jsonOf<{
      shared: boolean;
      galleryListed: boolean;
      galleryTemplatable: boolean;
    }>(res);
    expect(view.shared).toBe(false);
    expect(view.galleryListed).toBe(false);
    expect(view.galleryTemplatable).toBe(false);
  });

  it("unpublish 409s on an archived canvas, and on a disabled canvas without laundering the takedown", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const mk = async () =>
      (
        await jsonOf<{ id: string }>(
          await app.request("/api/canvases/paste", {
            method: "POST",
            headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
            body: JSON.stringify({ html: "<h1>hi</h1>" }),
          }),
        )
      ).id;
    const unpublish = (id: string) =>
      app.request(`/api/canvases/${id}/unpublish`, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
      });

    const archived = await mk();
    await repo.archive(archived);
    expect((await unpublish(archived)).status).toBe(409);

    const disabled = await mk();
    await repo.setDisabled(disabled, "policy");
    const res = await unpublish(disabled);
    expect(res.status).toBe(409);
    // Takedown is not laundered: the canvas stays disabled with its version intact.
    const after = await repo.findById(disabled);
    expect(after?.status).toBe("disabled");
    expect(after?.currentVersionId).not.toBeNull();
  });

  it("an admin CANNOT unpublish another owner's canvas (owner management is owner-only, 404)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const admin = await seedUser(client, "admin", true);
    const created = await jsonOf<{ id: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>hi</h1>" }),
      }),
    );
    const res = await buildApp(client, { id: admin.id, isAdmin: true }).request(
      `/api/canvases/${created.id}/unpublish`,
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(res.status).toBe(404);
    // The canvas is untouched — still published.
    expect(
      (await canvasesRepository(client).findById(created.id))?.currentVersionId,
    ).not.toBeNull();
  });

  it("share guard: the OWNER cannot re-share an ARCHIVED canvas (published means active + current version)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const created = await jsonOf<{ id: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request("/api/canvases/paste", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ html: "<h1>hi</h1>" }),
      }),
    );
    await repo.archive(created.id); // archived keeps currentVersionId
    const res = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      `/api/canvases/${created.id}/settings`,
      {
        method: "PATCH",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ shared: true }),
      },
    );
    expect(res.status).toBe(409);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("SHARE_REQUIRES_PUBLISH");
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
      await app.request("/api/canvases?scope=archived"),
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

  it("a non-owner cannot archive (404, no existence leak) — including an admin", async () => {
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

    // Archive is owner-only; a non-owner admin gets the same 404 (no owner powers on
    // another user's canvas — moderation is the admin routes' disable/enable/restore).
    const asAdmin = await buildApp(client, { id: admin.id, isAdmin: true }).request(
      `/api/canvases/${created.id}/archive`,
      { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(asAdmin.status).toBe(404);
    expect((await canvasesRepository(client).findById(created.id))?.status).toBe("active");
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
        canPublishPublic: true,
        providerSub: "secret-sub",
        isBlocked: false,
        createdAt: 123,
      } as never);
      await next();
    });
    app.route(
      "/api/me",
      meRoutes({
        authMode: "oidc",
        urlMode: "subdomain",
        baseUrl: "https://example.com",
        designSkin: async () => "workshop",
        orgs: { findById: async () => null },
        tenancyActive: false,
      }),
    );
    const body = await jsonOf<Record<string, unknown>>(await app.request("/api/me"));
    expect(Object.keys(body).sort()).toEqual([
      "authMode",
      "avatarUrl",
      "baseUrl",
      "canPublishPublic",
      "designSkin",
      "email",
      "id",
      "isAdmin",
      "isGuest",
      "name",
      "orgs",
      "urlMode",
    ]);
    expect(body.providerSub).toBeUndefined();
    expect(body.isBlocked).toBeUndefined();
    expect(body.isAdmin).toBe(true);
    expect(body.canPublishPublic).toBe(true);
    // authMode is instance config, not a spread of the user row.
    expect(body.authMode).toBe("oidc");
    // designSkin is instance presentation config, surfaced for the SPA's <html data-skin>.
    expect(body.designSkin).toBe("workshop");
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

  it("versions: owner downloads and deletes history, while current/non-owner/cross-origin delete are protected", async () => {
    const { zipSync, unzipSync } = await import("fflate");
    const { Buffer } = await import("node:buffer");
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const storage = memStorage();
    const app = buildApp(client, { id: owner.id, isAdmin: false }, storage);
    const created = await jsonOf<{ id: string }>(
      await app.request("/api/canvases", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
    const zip = (n: string) => Buffer.from(zipSync({ "index.html": new TextEncoder().encode(n) }));
    for (const n of ["<h1>one</h1>", "<h1>two</h1>"]) {
      await app.request(`/api/canvases/${created.id}/deploy/zip`, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
        body: zip(n),
      });
    }

    const download = await app.request(`/api/canvases/${created.id}/versions/1/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("-v1.zip");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    const entries = unzipSync(new Uint8Array(await download.arrayBuffer()));
    expect(new TextDecoder().decode(entries["index.html"])).toBe("<h1>one</h1>");

    const currentDelete = await app.request(`/api/canvases/${created.id}/versions/2`, {
      method: "DELETE",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(currentDelete.status).toBe(409);
    expect(await jsonOf<{ code: string }>(currentDelete)).toMatchObject({
      code: "CURRENT_VERSION",
    });

    const crossOrigin = await app.request(`/api/canvases/${created.id}/versions/1`, {
      method: "DELETE",
      headers: { Origin: "https://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);
    const denied = await buildApp(client, { id: other.id, isAdmin: false }, storage).request(
      `/api/canvases/${created.id}/versions/1`,
      { method: "DELETE", headers: { "Sec-Fetch-Site": "same-origin" } },
    );
    expect(denied.status).toBe(404);

    const deleted = await app.request(`/api/canvases/${created.id}/versions/1`, {
      method: "DELETE",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(deleted.status).toBe(200);
    expect(await jsonOf<{ ok: boolean; version: number }>(deleted)).toEqual({
      ok: true,
      version: 1,
    });
    const history = await jsonOf<{ versions: { number: number }[] }>(
      await app.request(`/api/canvases/${created.id}/versions`),
    );
    expect(history.versions.map((version) => version.number)).toEqual([2]);
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
    capabilities: {
      kv: boolean;
      files: boolean;
      ai: boolean;
      realtime: boolean;
      authoring: boolean;
    };
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

  it("create default: backend off, most feature flags stored on (authoring off), nothing effective", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const body = await createCanvas(buildApp(client, { id: owner.id, isAdmin: false }));
    expect(body.backendEnabled).toBe(false);
    // authoring is the one feature that ships stored-OFF (higher-privilege); the rest default on.
    expect(body.capabilities).toEqual({
      kv: true,
      files: true,
      ai: true,
      realtime: true,
      authoring: false,
    });
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
      body: JSON.stringify({ ai: false, backendEnabled: true, authoring: true }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<CapView>(res);
    expect(body.capabilities.ai).toBe(false);
    expect(body.capabilities.kv).toBe(true);
    expect(body.capabilities.authoring).toBe(true); // default-off flag flipped on
    const stored = await canvasesRepository(client).findById(created.id);
    expect(stored?.capAi).toBe(false);
    expect(stored?.capAuthoring).toBe(true);
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
      settings: {
        access: "whole_org",
        discoverability: "listed",
        galleryListed: true,
        galleryTemplatable: true,
      },
    });

    const res = await buildApp(client, { id: other.id, isAdmin: false }, storage).request(
      `/api/canvases/${src.id}/clone`,
      sameOriginPost,
    );
    expect(res.status).toBe(201);
    const body = await jsonOf<{ id: string }>(res);
    expect((await canvasesRepository(client).findById(body.id))?.ownerId).toBe(other.id);
  });

  it("an admin CANNOT clone another owner's private (non-template) canvas → 404 (no content exfil)", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const admin = await seedUser(client, "admin", true);
    // Default seedCanvas is private + not gallery-listed. An admin is treated like any
    // non-owner here (clone reads no isAdmin), so it can't clone it into an owned copy.
    const src = await seedCanvas(storage, owner.id, { slug: "src", apiKeyHash: "k1" });
    const res = await buildApp(client, { id: admin.id, isAdmin: true }, storage).request(
      `/api/canvases/${src.id}/clone`,
      sameOriginPost,
    );
    expect(res.status).toBe(404);
  });

  it("non-owner cannot clone a listed-but-NOT-templatable canvas → 404 (opaque)", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const src = await seedCanvas(storage, owner.id, {
      slug: "tmpl",
      apiKeyHash: "k1",
      settings: { access: "whole_org", discoverability: "listed", galleryListed: true }, // not templatable
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
      settings: {
        access: "whole_org",
        discoverability: "listed",
        galleryListed: true,
        galleryTemplatable: true,
      },
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
    expect(await jsonOf<{ discoverability: string; galleryListed: boolean }>(res)).toMatchObject({
      discoverability: "listed",
      galleryListed: true,
    });
  });

  it("setting a password on a listed canvas un-lists it and clears templatable", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const id = await makeCanvas(owner.id, true);
    await patch(app, id, {
      shared: true,
      discoverability: "listed",
      galleryListed: true,
      galleryTemplatable: true,
    });

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

    expect(
      (await patch(app, id, { shared: true, discoverability: "listed", galleryListed: true }))
        .status,
    ).toBe(409);
  });

  it("rejects templatable while unlisted, and un-listing clears templatable", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const id = await makeCanvas(owner.id, true);

    // Templatable while unlisted → rejected.
    expect((await patch(app, id, { galleryTemplatable: true })).status).toBe(409);

    // List + templatable, then un-list → templatable cleared.
    await patch(app, id, {
      shared: true,
      discoverability: "listed",
      galleryListed: true,
      galleryTemplatable: true,
    });
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
      discoverability: "listed",
      galleryListed: true,
      galleryTemplatable: true,
      description: "a handy starter",
      tags: ["starter"],
    });

    const res = await patch(app, id, { shared: false });
    const body = await jsonOf<{
      galleryListed: boolean;
      galleryTemplatable: boolean;
      description: string | null;
      tags: string[] | null;
    }>(res);
    expect(body.galleryListed).toBe(false);
    expect(body.galleryTemplatable).toBe(false);
    // Metadata is retained so re-sharing restores it without re-typing.
    expect(body.description).toBe("a handy starter");
    expect(body.tags).toEqual(["starter"]);
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
      summary: {
        active: number;
        archived: number;
        shared: number;
        protected: number;
        listed: number;
        templates: number;
        neverDeployed: number;
      };
    }>(res);
    expect(body.total).toBe(2);
    expect(body.canvases).toHaveLength(2);
    expect(body.limit).toBe(30);
    expect(body.offset).toBe(0);
    expect(body.summary).toMatchObject({
      active: 2,
      archived: 0,
      shared: 0,
      protected: 0,
      listed: 0,
      templates: 0,
      neverDeployed: 2,
    });
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
    // limit over the max clamps to 100; negative offset clamps to 0.
    const over = await jsonOf<{ limit: number; offset: number; total: number }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request(
        "/api/canvases?limit=9999&offset=-5",
      ),
    );
    expect(over.limit).toBe(100);
    expect(over.offset).toBe(0);
    expect(over.total).toBe(3);
    // non-numeric limit falls back to the default page size, not a 400.
    const junk = await buildApp(client, { id: owner.id, isAdmin: false }).request(
      "/api/canvases?limit=abc",
    );
    expect(junk.status).toBe(200);
    expect((await jsonOf<{ limit: number }>(junk)).limit).toBe(30);
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

  it("GET /?access= filters the owner list by rung; a junk value keeps the other filters", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    await repo.create({ ownerId: owner.id, slug: "priv", apiKeyHash: "k1", title: "Keep me" });
    const pub = await repo.create({ ownerId: owner.id, slug: "pub", apiKeyHash: "k2" });
    await repo.setAccess(pub.id, "whole_org");
    // Legacy aliases of `private` (restricted access model).
    const people = await repo.create({ ownerId: owner.id, slug: "people", apiKeyHash: "k3" });
    await repo.setAccess(people.id, "specific_people");
    const teamy = await repo.create({ ownerId: owner.id, slug: "teamy", apiKeyHash: "k4" });
    await repo.setAccess(teamy.id, "team");

    // access= narrows to the matching rung.
    const filtered = await jsonOf<{ canvases: Array<{ slug: string }> }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request(
        "/api/canvases?access=whole_org",
      ),
    );
    expect(filtered.canvases.map((c) => c.slug)).toEqual(["pub"]);
    // `restricted` = the whole family (the value the dashboard's filter sends).
    const restricted = await jsonOf<{ canvases: Array<{ slug: string }> }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request(
        "/api/canvases?access=restricted",
      ),
    );
    expect(restricted.canvases.map((c) => c.slug).sort()).toEqual(["people", "priv", "teamy"]);
    // An alias reads as NOT shared (open beyond the list) on the single-canvas view, with the
    // family's access mode.
    const view = await jsonOf<{ shared: boolean; accessMode: string; access: string }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request(
        `/api/canvases/${people.id}`,
      ),
    );
    expect(view).toMatchObject({
      access: "specific_people",
      shared: false,
      accessMode: "restricted",
    });

    // A junk ?access= (.catch) drops only itself — the q= filter still applies.
    const junk = await jsonOf<{ canvases: Array<{ slug: string }> }>(
      await buildApp(client, { id: owner.id, isAdmin: false }).request(
        "/api/canvases?q=Keep&access=garbage",
      ),
    );
    expect(junk.canvases.map((c) => c.slug)).toEqual(["priv"]);
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

describe("managementRoutes — access ladder + allowlist (U4)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  const mut = { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" };

  async function pasteCanvas(
    app: ReturnType<typeof buildApp>,
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await app.request("/api/canvases/paste", {
      method: "POST",
      headers: mut,
      body: JSON.stringify({ html: "<h1>hi</h1>", ...payload }),
    });
    expect(res.status).toBe(201);
    return (await jsonOf<{ id: string }>(res)).id;
  }

  /** Create a published canvas (paste create) owned by `owner`, return its id. */
  async function publishedCanvas(ownerId: string): Promise<string> {
    return pasteCanvas(buildApp(client, { id: ownerId, isAdmin: false }));
  }

  it("sets the access rung to specific_people (a Restricted alias — no publish needed; opening to the org does)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });

    // An unpublished canvas may move within the restricted family (nothing opens)…
    const draft = await jsonOf<{ id: string }>(
      await app.request("/api/canvases", { method: "POST", headers: mut, body: "{}" }),
    );
    const alias = await app.request(`/api/canvases/${draft.id}/settings`, {
      method: "PATCH",
      headers: mut,
      body: JSON.stringify({ access: "specific_people" }),
    });
    expect(alias.status).toBe(200);
    // …but not to a wide rung until it has something to show.
    const blocked = await app.request(`/api/canvases/${draft.id}/settings`, {
      method: "PATCH",
      headers: mut,
      body: JSON.stringify({ access: "whole_org" }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "SHARE_REQUIRES_PUBLISH" });

    const id = await publishedCanvas(owner.id);
    const ok = await app.request(`/api/canvases/${id}/settings`, {
      method: "PATCH",
      headers: mut,
      body: JSON.stringify({ access: "specific_people" }),
    });
    expect(ok.status).toBe(200);
    expect((await jsonOf<{ access: string }>(ok)).access).toBe("specific_people");
  });

  it("public_link is rejected for an owner whose publish capability was revoked", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const id = await publishedCanvas(owner.id);
    // The gate reads the OWNER's account entitlement (editor-roles plan, KD7).
    await usersRepository(client).setPublishPublic(owner.id, false);
    const res = await buildApp(client, {
      id: owner.id,
      isAdmin: false,
      canPublishPublic: false,
    }).request(`/api/canvases/${id}/settings`, {
      method: "PATCH",
      headers: mut,
      body: JSON.stringify({ access: "public_link" }),
    });
    expect(res.status).toBe(403);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("PUBLIC_NOT_ALLOWED");
  });

  it("public_link is settable by a fresh owner while the instance switch is on", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const id = await publishedCanvas(owner.id);
    const res = await buildApp(client, {
      id: owner.id,
      isAdmin: false,
    }).request(`/api/canvases/${id}/settings`, {
      method: "PATCH",
      headers: mut,
      body: JSON.stringify({ access: "public_link" }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ access: string }>(res)).access).toBe("public_link");
  });

  it("adds, lists, and removes an org member on the allowlist", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const member = await seedUser(client, "member");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const id = await publishedCanvas(owner.id);

    const add = await app.request(`/api/canvases/${id}/allowlist`, {
      method: "POST",
      headers: mut,
      body: JSON.stringify({ email: "member@example.com" }),
    });
    expect(add.status).toBe(200);
    expect((await jsonOf<{ status: string }>(add)).status).toBe("granted");

    const listed = await jsonOf<{ entries: Array<{ id: string; kind: string; email: string }> }>(
      await app.request(`/api/canvases/${id}/allowlist`),
    );
    // The owner row is pinned first (KTD5); the granted member follows.
    expect(listed.entries).toHaveLength(2);
    expect(listed.entries[0]).toMatchObject({ id: "owner", kind: "owner" });
    const entry = listed.entries[1];
    if (!entry) throw new Error("expected one allowlist entry");
    expect(entry.kind).toBe("member");
    expect(entry.email).toBe("member@example.com");
    expect(entry.id).toMatch(/^member:/);

    const del = await app.request(`/api/canvases/${id}/allowlist/${entry.id}`, {
      method: "DELETE",
      headers: mut,
    });
    expect(del.status).toBe(200);
    const after = await jsonOf<{ entries: Array<{ kind: string }> }>(
      await app.request(`/api/canvases/${id}/allowlist`),
    );
    expect(after.entries.map((e) => e.kind)).toEqual(["owner"]);
    void member;
  });

  it("GET /shared lists direct grants and team grants at every rung (no discoverability opt-in)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const directMember = await seedUser(client, "direct-member");
    const teammate = await seedUser(client, "teammate");
    const outsider = await seedUser(client, "outsider");
    const ownerApp = buildApp(client, { id: owner.id, isAdmin: false });
    const directCanvas = await publishedCanvas(owner.id);
    const teamCanvas = await publishedCanvas(owner.id);
    const canvases = canvasesRepository(client);
    const teams = teamsRepository(client);
    const team = await teams.create({ orgId: null, name: "Design", createdBy: owner.id });
    await teams.addMember(team.id, teammate.id);

    await canvases.addAllowlistEntry({
      canvasId: directCanvas,
      principalKind: "member",
      userId: directMember.id,
    });
    expect(
      (
        await ownerApp.request(`/api/canvases/${directCanvas}/settings`, {
          method: "PATCH",
          headers: mut,
          body: JSON.stringify({ access: "specific_people" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await ownerApp.request(`/api/canvases/${directCanvas}/settings`, {
          method: "PATCH",
          headers: mut,
          body: JSON.stringify({ password: "secret" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await ownerApp.request(`/api/canvases/${teamCanvas}/settings`, {
          method: "PATCH",
          headers: mut,
          body: JSON.stringify({ access: "team", teamIds: [team.id] }),
        })
      ).status,
    ).toBe(200);

    // A team on the list is an open door (restricted access model): the teammate sees the
    // canvas in Shared at once — `discoverability` now governs whole_org listing only.
    const teamAtOnce = await jsonOf<{ canvases: Array<{ id: string }>; total: number }>(
      await buildApp(client, { id: teammate.id, isAdmin: false }).request("/api/canvases/shared"),
    );
    expect(teamAtOnce.total).toBe(1);
    expect(teamAtOnce.canvases.map((c) => c.id)).toEqual([teamCanvas]);

    expect(
      (
        await ownerApp.request(`/api/canvases/${teamCanvas}/settings`, {
          method: "PATCH",
          headers: mut,
          body: JSON.stringify({ discoverability: "listed" }),
        })
      ).status,
    ).toBe(200);

    const direct = await jsonOf<{
      canvases: Array<{
        id: string;
        access: { kind: string };
        hasPassword: boolean;
        owner: { name: string } | null;
      }>;
      total: number;
    }>(
      await buildApp(client, { id: directMember.id, isAdmin: false }).request(
        "/api/canvases/shared?q=owner",
      ),
    );
    expect(direct.total).toBe(1);
    expect(direct.canvases).toEqual([
      expect.objectContaining({
        id: directCanvas,
        access: expect.objectContaining({ kind: "direct" }),
        hasPassword: true,
        owner: expect.objectContaining({ name: "owner" }),
      }),
    ]);

    const teamListed = await jsonOf<{
      canvases: Array<{
        id: string;
        access: { kind: string; label: string; teamNames?: string[] };
      }>;
      total: number;
    }>(
      await buildApp(client, { id: teammate.id, isAdmin: false }).request(
        "/api/canvases/shared?q=design",
      ),
    );
    expect(teamListed.total).toBe(1);
    expect(teamListed.canvases).toEqual([
      expect.objectContaining({
        id: teamCanvas,
        access: expect.objectContaining({
          kind: "team",
          label: "Design",
          teamNames: ["Design"],
        }),
      }),
    ]);

    const ownerView = await jsonOf<{ canvases: unknown[]; total: number }>(
      await ownerApp.request("/api/canvases/shared"),
    );
    expect(ownerView).toMatchObject({ canvases: [], total: 0 });
    const outsiderView = await jsonOf<{ canvases: unknown[]; total: number }>(
      await buildApp(client, { id: outsider.id, isAdmin: false }).request("/api/canvases/shared"),
    );
    expect(outsiderView).toMatchObject({ canvases: [], total: 0 });
  });

  it("GET /shared lists only discoverable Whole-org canvases for same-org non-owners", async () => {
    client = await makeTestDb("sqlite");
    const tenantConfig = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_ORG_NAME: "A",
    });
    const orgs = orgsRepository(client);
    const orgA = await orgs.ensureOrg({ name: "A", slug: "a", domains: ["a.example"] });
    const orgB = await orgs.ensureOrg({ name: "B", slug: "b", domains: ["b.example"] });
    const owner = await seedUser(client, "owner");
    const sameOrg = await seedUser(client, "same-org");
    const otherOrg = await seedUser(client, "other-org");
    const noOrg = await seedUser(client, "no-org");
    const tenantApp = (actor: {
      id: string;
      isAdmin: boolean;
      orgIds?: Set<string>;
      canPublishPublic?: boolean;
    }) => buildApp(client, actor, undefined, undefined, true, false, undefined, tenantConfig);
    const ownerApp = tenantApp({ id: owner.id, isAdmin: false, orgIds: new Set([orgA.id]) });

    const listed = await pasteCanvas(ownerApp, { title: "Listed org canvas", orgId: orgA.id });
    const linkOnly = await pasteCanvas(ownerApp, { title: "Link-only org canvas", orgId: orgA.id });
    const expired = await pasteCanvas(ownerApp, { title: "Expired org canvas", orgId: orgA.id });
    const publicLink = await pasteCanvas(ownerApp, { title: "Public link canvas", orgId: orgA.id });

    for (const id of [listed, linkOnly, expired]) {
      expect(
        (
          await ownerApp.request(`/api/canvases/${id}/settings`, {
            method: "PATCH",
            headers: mut,
            body: JSON.stringify({ access: "whole_org" }),
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await ownerApp.request(`/api/canvases/${listed}/settings`, {
          method: "PATCH",
          headers: mut,
          body: JSON.stringify({ discoverability: "listed" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await ownerApp.request(`/api/canvases/${expired}/settings`, {
          method: "PATCH",
          headers: mut,
          body: JSON.stringify({ discoverability: "listed", sharedExpiresAt: Date.now() - 1000 }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await ownerApp.request(`/api/canvases/${publicLink}/settings`, {
          method: "PATCH",
          headers: mut,
          body: JSON.stringify({ access: "public_link" }),
        })
      ).status,
    ).toBe(200);

    const idsFor = async (actor: { id: string; orgIds?: Set<string> }) => {
      const body = await jsonOf<{ canvases: Array<{ id: string }>; total: number }>(
        await tenantApp({ id: actor.id, isAdmin: false, orgIds: actor.orgIds }).request(
          "/api/canvases/shared",
        ),
      );
      return { total: body.total, ids: body.canvases.map((c) => c.id) };
    };

    expect(await idsFor({ id: sameOrg.id, orgIds: new Set([orgA.id]) })).toEqual({
      total: 1,
      ids: [listed],
    });
    expect(await idsFor({ id: owner.id, orgIds: new Set([orgA.id]) })).toEqual({
      total: 0,
      ids: [],
    });
    expect(await idsFor({ id: otherOrg.id, orgIds: new Set([orgB.id]) })).toEqual({
      total: 0,
      ids: [],
    });
    expect(await idsFor({ id: noOrg.id, orgIds: new Set() })).toEqual({ total: 0, ids: [] });
  });

  it("GET /shared search, sorting, and pagination stay server-side and stable", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const viewer = await seedUser(client, "viewer");
    const ownerApp = buildApp(client, { id: owner.id, isAdmin: false });
    const canvases = canvasesRepository(client);

    const shareDirect = async (
      title: string,
      slug: string,
      patch: { description?: string | null; tags?: string[] | null } = {},
    ) => {
      const id = await pasteCanvas(ownerApp, { title, slug });
      await canvases.addAllowlistEntry({
        canvasId: id,
        principalKind: "member",
        userId: viewer.id,
      });
      await canvases.updateSettings(id, {
        access: "specific_people",
        ...patch,
      });
      return id;
    };

    await shareDirect("Gamma Notes", "gamma-notes");
    await shareDirect("Alpha Plan", "alpha-plan");
    await shareDirect("Beta Revenue", "beta-revenue", {
      description: "Quarterly finance summary",
      tags: ["board"],
    });

    const page = await jsonOf<{
      canvases: Array<{ title: string }>;
      total: number;
      limit: number;
      offset: number;
    }>(
      await buildApp(client, { id: viewer.id, isAdmin: false }).request(
        "/api/canvases/shared?sort=title&limit=2&offset=1",
      ),
    );
    expect(page).toMatchObject({ total: 3, limit: 2, offset: 1 });
    expect(page.canvases.map((c) => c.title)).toEqual(["Beta Revenue", "Gamma Notes"]);

    const searched = await jsonOf<{ canvases: Array<{ title: string }>; total: number }>(
      await buildApp(client, { id: viewer.id, isAdmin: false }).request(
        "/api/canvases/shared?q=quarterly%20board",
      ),
    );
    expect(searched.total).toBe(1);
    expect(searched.canvases.map((c) => c.title)).toEqual(["Beta Revenue"]);

    const emptySearch = await jsonOf<{
      canvases: Array<{ title: string }>;
      total: number;
      limit: number;
      offset: number;
    }>(
      await buildApp(client, { id: viewer.id, isAdmin: false }).request(
        "/api/canvases/shared?q=&sort=title&limit=2&offset=1",
      ),
    );
    expect(emptySearch).toMatchObject({ total: 3, limit: 2, offset: 1 });
    expect(emptySearch.canvases.map((c) => c.title)).toEqual(["Beta Revenue", "Gamma Notes"]);
  });

  it("PATCH /settings audits discoverability-only share changes", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const id = await publishedCanvas(owner.id);

    expect(
      (
        await app.request(`/api/canvases/${id}/settings`, {
          method: "PATCH",
          headers: mut,
          body: JSON.stringify({ access: "whole_org" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/canvases/${id}/settings`, {
          method: "PATCH",
          headers: mut,
          body: JSON.stringify({ discoverability: "listed" }),
        })
      ).status,
    ).toBe(200);

    await vi.waitFor(async () => {
      const rows = await auditRepository(client).recent(20);
      const discoveryAudit = rows.find((row) => {
        const meta = row.meta;
        return (
          row.action === "share_change" &&
          meta !== null &&
          typeof meta === "object" &&
          !Array.isArray(meta) &&
          meta.discoverability === "listed"
        );
      });
      expect(discoveryAudit?.targetId).toBe(id);
    });
  });

  it("individual invite (plan 003 U8): an existing user is granted (allowlist member); a new external email is rejected for a self-serve owner", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    await seedUser(client, "pal"); // pal@example.com — an existing user
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const id = await publishedCanvas(owner.id);

    // Existing user → granted now + lands on the allowlist as a member.
    const granted = await app.request(`/api/canvases/${id}/invite`, {
      method: "POST",
      headers: mut,
      body: JSON.stringify({ email: "pal@example.com" }),
    });
    expect(granted.status).toBe(200);
    expect((await jsonOf<{ status: string }>(granted)).status).toBe("granted");
    const listed = await jsonOf<{ entries: Array<{ kind: string; email: string }> }>(
      await app.request(`/api/canvases/${id}/allowlist`),
    );
    expect(listed.entries.map((e) => e.email)).toContain("pal@example.com");

    // A brand-new external email, self-serve owner, toggle off → rejected (KTD5).
    const rejected = await app.request(`/api/canvases/${id}/invite`, {
      method: "POST",
      headers: mut,
      body: JSON.stringify({ email: "stranger@outside.test" }),
    });
    expect(rejected.status).toBe(403);
    expect((await jsonOf<{ code: string }>(rejected)).code).toBe("NOT_PERMITTED");
  });

  it("Add person records admitted external emails as pending allowlist rows", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const email = "outsider@partner.com";
    await allowedEmailsRepository(client).add(email, owner.id);
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const id = await publishedCanvas(owner.id);

    const res = await app.request(`/api/canvases/${id}/allowlist`, {
      method: "POST",
      headers: mut,
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ status: string }>(res)).status).toBe("pending");

    const dup = await app.request(`/api/canvases/${id}/allowlist`, {
      method: "POST",
      headers: mut,
      body: JSON.stringify({ email }),
    });
    expect(dup.status).toBe(200);
    expect((await jsonOf<{ status: string }>(dup)).status).toBe("already_pending");

    const listed = await jsonOf<{ entries: Array<{ kind: string; email: string }> }>(
      await app.request(`/api/canvases/${id}/allowlist`),
    );
    expect(listed.entries.filter((e) => e.kind !== "owner")).toEqual([
      expect.objectContaining({ kind: "pending", email, role: "viewer" }),
    ]);
    expect(await guestRepository(client).listInvitesByCanvas(id)).toHaveLength(0);

    const materialized = await usersRepository(client).upsert({
      providerSub: "external:outsider",
      email,
      name: "Outside Partner",
      isAdmin: false,
    });
    await canvasesRepository(client).addAllowlistEntry({
      canvasId: id,
      principalKind: "member",
      userId: materialized.id,
    });
    const afterMaterialize = await jsonOf<{ entries: Array<{ kind: string; email: string }> }>(
      await app.request(`/api/canvases/${id}/allowlist`),
    );
    expect(afterMaterialize.entries.filter((e) => e.kind !== "owner")).toEqual([
      expect.objectContaining({ kind: "member", email }),
    ]);
  });

  it("removes pending Add person rows without touching other canvas invitations", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other-owner");
    const id = await publishedCanvas(owner.id);
    const otherCanvasId = await publishedCanvas(other.id);
    const pendingEmail = "pending@partner.com";
    const otherEmail = "other-pending@partner.com";
    await allowedEmailsRepository(client).add(pendingEmail, owner.id);
    await allowedEmailsRepository(client).add(otherEmail, owner.id);
    const invitations = invitationsRepository(client);
    await invitations.record({
      email: otherEmail,
      target: { type: "canvas", id: otherCanvasId },
      invitedBy: other.id,
    });
    const otherPending = (await invitations.listPendingForTarget("canvas", otherCanvasId))[0];
    if (!otherPending) throw new Error("expected other pending access row");
    const calls: Array<{ method: string; canvasId: string }> = [];
    const hub = {
      revalidateCanvas: async (canvasId: string) => {
        calls.push({ method: "revalidateCanvas", canvasId });
      },
    };
    const app = buildApp(client, { id: owner.id, isAdmin: false }, memStorage(), hub);

    const crossCanvas = await app.request(
      `/api/canvases/${id}/allowlist/pending:${otherPending.id}`,
      { method: "DELETE", headers: mut },
    );
    expect(crossCanvas.status).toBe(404);
    expect(await invitations.listForEmail(otherEmail)).toHaveLength(1);

    const res = await app.request(`/api/canvases/${id}/allowlist`, {
      method: "POST",
      headers: mut,
      body: JSON.stringify({ email: pendingEmail }),
    });
    expect(res.status).toBe(200);
    const entry = (
      await jsonOf<{ entries: Array<{ id: string; kind: string; email: string }> }>(
        await app.request(`/api/canvases/${id}/allowlist`),
      )
    ).entries.find((e) => e.kind === "pending" && e.email === pendingEmail);
    if (!entry) throw new Error("expected pending entry");

    const del = await app.request(`/api/canvases/${id}/allowlist/${entry.id}`, {
      method: "DELETE",
      headers: mut,
    });
    expect(del.status).toBe(200);
    expect(await invitations.listForEmail(pendingEmail)).toHaveLength(0);
    expect(calls).toContainEqual({ method: "revalidateCanvas", canvasId: id });
  });

  it("Add person no longer depends on the legacy guest service", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const email = "outsider@partner.com";
    await allowedEmailsRepository(client).add(email, owner.id);
    const id = await publishedCanvas(owner.id);
    const app = buildApp(client, { id: owner.id, isAdmin: false }, undefined, undefined, false);
    const res = await app.request(`/api/canvases/${id}/allowlist`, {
      method: "POST",
      headers: mut,
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ status: string }>(res)).status).toBe("pending");
    expect(await guestRepository(client).listInvitesByCanvas(id)).toHaveLength(0);
  });

  it("revoking a guest entry revokes its invite + sessions", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const app = buildApp(client, { id: owner.id, isAdmin: false });
    const id = await publishedCanvas(owner.id);
    const canvases = canvasesRepository(client);
    const guests = guestRepository(client);
    await canvases.addAllowlistEntry({
      canvasId: id,
      principalKind: "guest",
      email: "g@partner.com",
    });
    const invite = await guests.createInvite({
      canvasId: id,
      email: "g@partner.com",
      tokenHash: hashToken("legacy-invite-token"),
      expiresAt: null,
    });
    await guests.createSession({
      inviteId: invite.id,
      canvasId: id,
      tokenHash: hashToken("legacy-session-token"),
      expiresAt: Date.now() + 60_000,
    });
    const entry = (
      await jsonOf<{ entries: Array<{ id: string; kind: string }> }>(
        await app.request(`/api/canvases/${id}/allowlist`),
      )
    ).entries.find((e) => e.kind === "guest");
    if (!entry) throw new Error("expected a guest entry");
    const del = await app.request(`/api/canvases/${id}/allowlist/${entry.id}`, {
      method: "DELETE",
      headers: mut,
    });
    expect(del.status).toBe(200);
    const after = await jsonOf<{ entries: Array<{ kind: string }> }>(
      await app.request(`/api/canvases/${id}/allowlist`),
    );
    expect(after.entries.map((e) => e.kind)).toEqual(["owner"]);
    expect(await guests.findLiveSessionByTokenHash(hashToken("legacy-session-token"))).toBeNull();
  });

  it("a non-owner cannot manage another canvas's allowlist (404)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const other = await seedUser(client, "other");
    const id = await publishedCanvas(owner.id);
    const res = await buildApp(client, { id: other.id, isAdmin: false }).request(
      `/api/canvases/${id}/allowlist`,
      { method: "POST", headers: mut, body: JSON.stringify({ email: "x@example.com" }) },
    );
    expect(res.status).toBe(404);
  });
});

// --- Role matrix (editor-roles plan U2, KTD1): owner / editor / viewer / no role ×
//     read / mutate / owner-only. Rejection paths first. -----------------------------

describe("managementRoutes — role matrix (editor-roles plan)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });
  const so = { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" } as const;

  async function seedRoles() {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const editor = await seedUser(client, "editor");
    const viewer = await seedUser(client, "viewer");
    const nobody = await seedUser(client, "nobody");
    const admin = await seedUser(client, "admin", true);
    const repo = canvasesRepository(client);
    // General access stays PRIVATE: an editor must reach the surface regardless (AE2).
    const cv = await repo.create({ ownerId: owner.id, slug: "matrix", apiKeyHash: "k" });
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    await repo.addAllowlistEntry({ canvasId: cv.id, principalKind: "member", userId: viewer.id });
    const as = (u: { id: string }, isAdmin = false) => buildApp(client, { id: u.id, isAdmin });
    return { repo, cv, owner, editor, viewer, nobody, admin, as };
  }

  it("READ (GET /:id, /versions, /usage): owner + editor 200; viewer, no-role, admin 404", async () => {
    const { cv, owner, editor, viewer, nobody, admin, as } = await seedRoles();
    for (const path of [
      `/api/canvases/${cv.id}`,
      `/api/canvases/${cv.id}/versions`,
      `/api/canvases/${cv.id}/usage`,
    ]) {
      expect((await as(viewer).request(path)).status, `viewer ${path}`).toBe(404);
      expect((await as(nobody).request(path)).status, `nobody ${path}`).toBe(404);
      expect((await as(admin, true).request(path)).status, `admin ${path}`).toBe(404);
      expect((await as(owner).request(path)).status, `owner ${path}`).toBe(200);
      expect((await as(editor).request(path)).status, `editor ${path}`).toBe(200);
    }
  });

  it("MUTATE (PATCH /:id/settings, /capabilities): owner + editor 200; viewer, no-role, admin 404", async () => {
    const { cv, owner, editor, viewer, nobody, admin, as } = await seedRoles();
    const patch = (
      u: { id: string },
      isAdmin = false,
      path = "settings",
      body: unknown = { title: "t" },
    ) =>
      as(u, isAdmin).request(`/api/canvases/${cv.id}/${path}`, {
        method: "PATCH",
        headers: so,
        body: JSON.stringify(body),
      });
    expect((await patch(viewer)).status).toBe(404);
    expect((await patch(nobody)).status).toBe(404);
    expect((await patch(admin, true)).status).toBe(404);
    expect((await patch(owner)).status).toBe(200);
    const res = await patch(editor, false, "settings", { title: "by editor" });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ title: string }>(res)).title).toBe("by editor");
    expect((await patch(editor, false, "capabilities", { kv: false })).status).toBe(200);
  });

  it("OWNER-ONLY (DELETE /:id): editor → 403 OWNER_ONLY; viewer / no-role → 404; owner → 200 (AE4)", async () => {
    const { repo, cv, owner, editor, viewer, nobody, as } = await seedRoles();
    const del = (u: { id: string }) =>
      as(u).request(`/api/canvases/${cv.id}`, { method: "DELETE", headers: so });
    expect((await del(viewer)).status).toBe(404);
    expect((await del(nobody)).status).toBe(404);
    const asEditor = await del(editor);
    expect(asEditor.status).toBe(403);
    expect(await jsonOf<{ code: string }>(asEditor)).toEqual({
      code: "OWNER_ONLY",
      message: expect.stringMatching(/owner/i),
    });
    expect((await repo.findById(cv.id))?.status).toBe("active");
    expect((await del(owner)).status).toBe(200);
    expect((await repo.findById(cv.id))?.status).toBe("deleted");
  });

  it("check order is role → owner-only → disabled: on a DISABLED canvas an editor's delete is 403 OWNER_ONLY (not 409), no-role is 404, owner is 409", async () => {
    const { repo, cv, owner, editor, nobody, as } = await seedRoles();
    await repo.setDisabled(cv.id, "abuse");
    const del = (u: { id: string }) =>
      as(u).request(`/api/canvases/${cv.id}`, { method: "DELETE", headers: so });
    expect((await del(nobody)).status).toBe(404);
    const asEditor = await del(editor);
    expect(asEditor.status).toBe(403);
    expect((await jsonOf<{ code: string }>(asEditor)).code).toBe("OWNER_ONLY");
    const asOwner = await del(owner);
    expect(asOwner.status).toBe(409);
    expect((await jsonOf<{ code: string }>(asOwner)).code).toBe("DISABLED");
    // An editor's ordinary mutation on the disabled canvas is the shared 409; reads stay 200.
    const patch = await as(editor).request(`/api/canvases/${cv.id}/settings`, {
      method: "PATCH",
      headers: so,
      body: JSON.stringify({ title: "x" }),
    });
    expect(patch.status).toBe(409);
    expect((await jsonOf<{ code: string }>(patch)).code).toBe("DISABLED");
    expect((await as(editor).request(`/api/canvases/${cv.id}`)).status).toBe(200);
  });

  it("GET /by-slug/:slug resolves for the owner AND an editor; viewer / no-role 404", async () => {
    const { cv, owner, editor, viewer, nobody, as } = await seedRoles();
    const get = (u: { id: string }) => as(u).request(`/api/canvases/by-slug/${cv.slug}`);
    expect((await get(viewer)).status).toBe(404);
    expect((await get(nobody)).status).toBe(404);
    expect(await jsonOf<{ id: string }>(await get(owner))).toEqual({ id: cv.id });
    expect(await jsonOf<{ id: string }>(await get(editor))).toEqual({ id: cv.id });
  });

  it("removal takes effect on the next request: a demoted editor is 404 on read and mutate", async () => {
    const { repo, cv, editor, as } = await seedRoles();
    expect((await as(editor).request(`/api/canvases/${cv.id}`)).status).toBe(200);
    const entry = await repo.findMemberEntry(cv.id, editor.id);
    await repo.setAllowlistRole(cv.id, (entry as { id: string }).id, "viewer");
    expect((await as(editor).request(`/api/canvases/${cv.id}`)).status).toBe(404);
    await repo.removeAllowlistEntry(cv.id, (entry as { id: string }).id);
    expect(
      (
        await as(editor).request(`/api/canvases/${cv.id}/settings`, {
          method: "PATCH",
          headers: so,
          body: JSON.stringify({ title: "x" }),
        })
      ).status,
    ).toBe(404);
  });
});

// --- Clone by an editor (editor-roles plan U3) -------------------------------------------

describe("managementRoutes — clone by an editor", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("an editor clones a PRIVATE canvas → new canvas owned by the editor with an empty people list; a no-role member → 404", async () => {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const editor = await seedUser(client, "editor");
    const nobody = await seedUser(client, "nobody");
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
    const src = await canvases.create({ ownerId: owner.id, slug: "src", apiKeyHash: "k1" });
    await engine.deploy(src, "folder", folder({ "index.html": "<h1>hi</h1>" }), owner.id);
    await canvases.addAllowlistEntry({
      canvasId: src.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });

    const denied = await buildApp(client, { id: nobody.id, isAdmin: false }, storage).request(
      `/api/canvases/${src.id}/clone`,
      sameOriginPost,
    );
    expect(denied.status).toBe(404);

    const res = await buildApp(client, { id: editor.id, isAdmin: false }, storage).request(
      `/api/canvases/${src.id}/clone`,
      sameOriginPost,
    );
    expect(res.status).toBe(201);
    const body = await jsonOf<{ id: string }>(res);
    const clone = await canvases.findById(body.id);
    expect(clone?.ownerId).toBe(editor.id);
    expect(clone?.clonedFromCanvasId).toBe(src.id);
    expect(await canvases.listAllowlist(body.id)).toEqual([]);
  });
});

describe("managementRoutes — clone by a granted-team viewer (restricted access model, review #1/#7)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** A PRIVATE canvas with a viewer-team grant on its people-and-teams list. */
  async function seedTeamCanvas(opts: { publish: boolean }) {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const owner = await seedUser(client, "owner");
    const mate = await seedUser(client, "mate");
    const stranger = await seedUser(client, "stranger");
    const canvases = canvasesRepository(client);
    const teams = teamsRepository(client);
    const engine = deployEngine({
      config,
      canvases,
      versions: versionsRepository(client),
      drafts: draftsRepository(client),
      storage,
      log: silent,
    });
    const src = await canvases.create({ ownerId: owner.id, slug: "src", apiKeyHash: "k1" });
    if (opts.publish) {
      await engine.deploy(src, "folder", folder({ "index.html": "<h1>hi</h1>" }), owner.id);
    }
    const team = await teams.create({ orgId: null, name: "Design", createdBy: owner.id });
    await teams.addMember(team.id, mate.id);
    await teams.setCanvasTeams(src.id, [team.id]);
    const cloneAs = (u: { id: string }) =>
      buildApp(client, { id: u.id, isAdmin: false }, storage).request(
        `/api/canvases/${src.id}/clone`,
        sameOriginPost,
      );
    return { canvases, src, owner, mate, stranger, cloneAs };
  }

  it("a viewer-team member clones a published PRIVATE canvas (the list applies at every rung); a non-member gets 404", async () => {
    const { canvases, src, mate, stranger, cloneAs } = await seedTeamCanvas({ publish: true });
    expect((await canvases.findById(src.id))?.access).toBe("private");
    expect((await cloneAs(stranger)).status).toBe(404);
    const res = await cloneAs(mate);
    expect(res.status).toBe(201);
    const body = await jsonOf<{ id: string }>(res);
    const clone = await canvases.findById(body.id);
    expect(clone?.ownerId).toBe(mate.id);
    expect(clone?.clonedFromCanvasId).toBe(src.id);
  });

  it("the fences: a never-published source reads 404 for the team viewer (never a copy of the owner's draft); the owner still clones it", async () => {
    const { owner, mate, cloneAs } = await seedTeamCanvas({ publish: false });
    expect((await cloneAs(mate)).status).toBe(404);
    expect((await cloneAs(owner)).status).toBe(201);
  });

  it("the fences: an expired share reads 404 for the team viewer; the owner still clones it", async () => {
    const { canvases, src, owner, mate, cloneAs } = await seedTeamCanvas({ publish: true });
    await canvases.updateSettings(src.id, { sharedExpiresAt: Date.now() - 60_000 });
    expect((await cloneAs(mate)).status).toBe(404);
    expect((await cloneAs(owner)).status).toBe(201);
  });

  it("the fences: a password-protected source reads 404 for the team viewer (the cloner would own the copy and bypass the gate); the owner still clones it", async () => {
    const { canvases, src, owner, mate, cloneAs } = await seedTeamCanvas({ publish: true });
    await canvases.setPassword(src.id, "argon2hash");
    expect((await cloneAs(mate)).status).toBe(404);
    expect((await cloneAs(owner)).status).toBe(201);
  });
});

// --- People-list roles over HTTP (editor-roles plan U4/U5) --------------------------------

describe("managementRoutes — people-list roles", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });
  const so = { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" } as const;
  type Entry = {
    id: string;
    kind: string;
    role: string;
    email: string | null;
    name: string | null;
  };

  async function seedPeople() {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const editor = await seedUser(client, "editor");
    const viewer = await seedUser(client, "viewer");
    const nobody = await seedUser(client, "nobody");
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId: owner.id, slug: "people", apiKeyHash: "k" });
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    await repo.addAllowlistEntry({ canvasId: cv.id, principalKind: "member", userId: viewer.id });
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "guest",
      email: "g@partner.com",
    });
    const hub = {
      calls: [] as Array<{ method: string; canvasId: string }>,
      async revalidateCanvas(canvasId: string) {
        this.calls.push({ method: "revalidateCanvas", canvasId });
      },
      async dropGatedNonOwners(canvasId: string) {
        this.calls.push({ method: "dropGatedNonOwners", canvasId });
      },
    };
    const as = (u: { id: string }) =>
      buildApp(client, { id: u.id, isAdmin: false }, undefined, hub);
    const list = async (u: { id: string }) =>
      (await jsonOf<{ entries: Entry[] }>(await as(u).request(`/api/canvases/${cv.id}/allowlist`)))
        .entries;
    return { repo, cv, owner, editor, viewer, nobody, hub, as, list };
  }

  it("GET lists the owner first, then people with roles, ids prefixed; an editor sees the same list", async () => {
    const { owner, editor, list } = await seedPeople();
    const entries = await list(owner);
    expect(entries[0]).toMatchObject({ id: "owner", kind: "owner", role: "owner" });
    expect(entries.map((e) => `${e.kind}:${e.role}`)).toEqual([
      "owner:owner",
      "member:editor",
      "member:viewer",
      "guest:viewer",
    ]);
    expect(entries.slice(1).every((e) => e.id.includes(":"))).toBe(true);
    expect(await list(editor)).toEqual(entries);
  });

  it("AE1: PATCH role=editor on a guest entry → 400 GUEST_VIEWER_ONLY", async () => {
    const { cv, owner, as, list } = await seedPeople();
    const guest = (await list(owner)).find((e) => e.kind === "guest") as Entry;
    const res = await as(owner).request(`/api/canvases/${cv.id}/allowlist/${guest.id}`, {
      method: "PATCH",
      headers: so,
      body: JSON.stringify({ role: "editor" }),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("GUEST_VIEWER_ONLY");
  });

  it("the owner entry: PATCH role and DELETE → 403 OWNER_ONLY, for the owner and an editor alike", async () => {
    const { cv, owner, editor, as } = await seedPeople();
    for (const u of [owner, editor]) {
      const patch = await as(u).request(`/api/canvases/${cv.id}/allowlist/owner`, {
        method: "PATCH",
        headers: so,
        body: JSON.stringify({ role: "viewer" }),
      });
      expect(patch.status).toBe(403);
      expect((await jsonOf<{ code: string }>(patch)).code).toBe("OWNER_ONLY");
      const del = await as(u).request(`/api/canvases/${cv.id}/allowlist/owner`, {
        method: "DELETE",
        headers: so,
      });
      expect(del.status).toBe(403);
    }
  });

  it("promote a viewer to editor by entry id (they can then manage); demote drops live sockets via revalidate", async () => {
    const { cv, owner, viewer, hub, as, list } = await seedPeople();
    const row = (await list(owner)).find((e) => e.email === "viewer@example.com") as Entry;
    expect((await as(viewer).request(`/api/canvases/${cv.id}`)).status).toBe(404);
    const up = await as(owner).request(`/api/canvases/${cv.id}/allowlist/${row.id}`, {
      method: "PATCH",
      headers: so,
      body: JSON.stringify({ role: "editor" }),
    });
    expect(up.status).toBe(200);
    expect((await as(viewer).request(`/api/canvases/${cv.id}`)).status).toBe(200);
    hub.calls.length = 0;
    const down = await as(owner).request(`/api/canvases/${cv.id}/allowlist/${row.id}`, {
      method: "PATCH",
      headers: so,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(down.status).toBe(200);
    expect(hub.calls).toContainEqual({ method: "revalidateCanvas", canvasId: cv.id });
    expect((await as(viewer).request(`/api/canvases/${cv.id}`)).status).toBe(404);
  });

  it("an entry id belonging to canvas B is 404 on canvas A and changes nothing", async () => {
    const { repo, cv, owner, editor, as, list } = await seedPeople();
    const other = await repo.create({ ownerId: owner.id, slug: "other", apiKeyHash: "k2" });
    const row = (await list(owner)).find((e) => e.email === "editor@example.com") as Entry;
    const res = await as(owner).request(`/api/canvases/${other.id}/allowlist/${row.id}`, {
      method: "PATCH",
      headers: so,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(res.status).toBe(404);
    expect((await repo.findMemberEntry(cv.id, editor.id))?.role).toBe("editor");
  });

  it("AE5: editor E1 removes editor E2 → E2 is 404 next; E1 can demote themselves to viewer", async () => {
    const { repo, cv, editor, as, list } = await seedPeople();
    const e2 = await seedUser(client, "e2");
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: e2.id,
      role: "editor",
    });
    expect((await as(e2).request(`/api/canvases/${cv.id}`)).status).toBe(200);
    const e2Row = (await list(editor)).find((e) => e.email === "e2@example.com") as Entry;
    const del = await as(editor).request(`/api/canvases/${cv.id}/allowlist/${e2Row.id}`, {
      method: "DELETE",
      headers: so,
    });
    expect(del.status).toBe(200);
    expect((await as(e2).request(`/api/canvases/${cv.id}`)).status).toBe(404);
    const self = (await list(editor)).find((e) => e.email === "editor@example.com") as Entry;
    const demote = await as(editor).request(`/api/canvases/${cv.id}/allowlist/${self.id}`, {
      method: "PATCH",
      headers: so,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(demote.status).toBe(200);
    expect((await as(editor).request(`/api/canvases/${cv.id}`)).status).toBe(404);
  });

  it("POST with role=editor grants an existing member as editor; re-adding without a role keeps editor; legacy bare ids still delete", async () => {
    const { repo, cv, owner, as, list } = await seedPeople();
    const fresh = await seedUser(client, "fresh");
    const add = await as(owner).request(`/api/canvases/${cv.id}/allowlist`, {
      method: "POST",
      headers: so,
      body: JSON.stringify({ email: "fresh@example.com", role: "editor" }),
    });
    expect(add.status).toBe(200);
    expect(await jsonOf<{ status: string; role: string }>(add)).toMatchObject({
      status: "granted",
      role: "editor",
    });
    const row = await repo.findMemberEntry(cv.id, fresh.id);
    expect(row?.role).toBe("editor");
    const readd = await as(owner).request(`/api/canvases/${cv.id}/allowlist`, {
      method: "POST",
      headers: so,
      body: JSON.stringify({ email: "fresh@example.com" }),
    });
    expect((await jsonOf<{ status: string }>(readd)).status).toBe("already_added");
    expect((await repo.findMemberEntry(cv.id, fresh.id))?.role).toBe("editor");
    // Legacy bare row id (pre-prefix clients) still works on DELETE.
    const del = await as(owner).request(
      `/api/canvases/${cv.id}/allowlist/${(row as { id: string }).id}`,
      {
        method: "DELETE",
        headers: so,
      },
    );
    expect(del.status).toBe(200);
    expect((await list(owner)).find((e) => e.email === "fresh@example.com")).toBeUndefined();
  });

  it("U5: add a team with role editor via the people list; a non-member actor gets 403 TEAM_FORBIDDEN", async () => {
    const { cv, owner, editor, nobody, as, list } = await seedPeople();
    const teams = teamsRepository(client);
    const design = await teams.create({ orgId: null, name: "Design", createdBy: owner.id });
    await teams.addMember(design.id, nobody.id);
    // The editor is not in Design → cannot grant it.
    const forbidden = await as(editor).request(`/api/canvases/${cv.id}/allowlist`, {
      method: "POST",
      headers: so,
      body: JSON.stringify({ teamId: design.id, role: "editor" }),
    });
    expect(forbidden.status).toBe(403);
    expect((await jsonOf<{ code: string }>(forbidden)).code).toBe("TEAM_FORBIDDEN");
    const ok = await as(owner).request(`/api/canvases/${cv.id}/allowlist`, {
      method: "POST",
      headers: so,
      body: JSON.stringify({ teamId: design.id, role: "editor" }),
    });
    expect(ok.status).toBe(200);
    expect(await list(owner)).toContainEqual(
      expect.objectContaining({
        id: `team:${design.id}`,
        kind: "team",
        role: "editor",
        name: "Design",
      }),
    );
    // Its member (previously no role) now manages the canvas (AE3).
    expect((await as(nobody).request(`/api/canvases/${cv.id}`)).status).toBe(200);
    await teams.removeMember(design.id, nobody.id);
    expect((await as(nobody).request(`/api/canvases/${cv.id}`)).status).toBe(404);
  });

  it("legacy `teamIds: []` carve-out (review #8/#9): with an access change OFF `team` it is a no-op and the grants survive; with any other access value it is TEAM_REQUIRED", async () => {
    const { repo, cv, owner, as, list } = await seedPeople();
    const engine = deployEngine({
      config,
      canvases: repo,
      versions: versionsRepository(client),
      drafts: draftsRepository(client),
      storage: memStorage(),
      log: silent,
    });
    await engine.deploy(cv, "folder", folder({ "index.html": "<h1>hi</h1>" }), owner.id);
    const teams = teamsRepository(client);
    const viewers = await teams.create({ orgId: null, name: "Viewers", createdBy: owner.id });
    const patch = (body: Record<string, unknown>) =>
      as(owner).request(`/api/canvases/${cv.id}/settings`, {
        method: "PATCH",
        headers: so,
        body: JSON.stringify(body),
      });
    expect((await patch({ access: "team", teamIds: [viewers.id] })).status).toBe(200);
    const teamGrants = async () => (await list(owner)).filter((e) => e.kind === "team").length;
    expect(await teamGrants()).toBe(1);

    // The old dashboard's "leave the Team rung" shape: a no-op for the grants.
    const off = await patch({ access: "whole_org", teamIds: [] });
    expect(off.status).toBe(200);
    expect(await teamGrants()).toBe(1);
    expect(
      (await jsonOf<{ teamIds: string[] }>(await as(owner).request(`/api/canvases/${cv.id}`)))
        .teamIds,
    ).toEqual([viewers.id]);

    // Off the `team` value, an empty set is refused whatever `access` says.
    const echoed = await patch({ access: "whole_org", teamIds: [] });
    expect(echoed.status).toBe(409);
    expect((await jsonOf<{ code: string }>(echoed)).code).toBe("TEAM_REQUIRED");
    const toPrivate = await patch({ access: "private", teamIds: [] });
    expect(toPrivate.status).toBe(409);
    const toTeam = await patch({ access: "team", teamIds: [] });
    expect(toTeam.status).toBe(409);
    expect(await teamGrants()).toBe(1);
  });

  it("AE13: legacy teamIds replaces only the VIEWER team grants; a rung change keeps every team grant (its members still edit)", async () => {
    const { repo, cv, owner, nobody, as, list } = await seedPeople();
    // Sharing rungs need a published canvas (the share guard): deploy one version first.
    const engine = deployEngine({
      config,
      canvases: repo,
      versions: versionsRepository(client),
      drafts: draftsRepository(client),
      storage: memStorage(),
      log: silent,
    });
    await engine.deploy(cv, "folder", folder({ "index.html": "<h1>hi</h1>" }), owner.id);
    const teams = teamsRepository(client);
    const viewers = await teams.create({ orgId: null, name: "Viewers", createdBy: owner.id });
    const editors = await teams.create({ orgId: null, name: "Editors", createdBy: owner.id });
    await teams.addMember(editors.id, nobody.id);
    // Team rung with the viewer team (the settings flow), plus an editor team via the people list.
    const rung = await as(owner).request(`/api/canvases/${cv.id}/settings`, {
      method: "PATCH",
      headers: so,
      body: JSON.stringify({ access: "team", teamIds: [viewers.id] }),
    });
    expect(rung.status).toBe(200);
    await as(owner).request(`/api/canvases/${cv.id}/allowlist`, {
      method: "POST",
      headers: so,
      body: JSON.stringify({ teamId: editors.id, role: "editor" }),
    });
    expect(
      (await list(owner))
        .filter((e) => e.kind === "team")
        .map((e) => e.role)
        .sort(),
    ).toEqual(["editor", "viewer"]);
    // A settings save replacing the viewer set (rung unchanged) leaves the editor grant intact.
    const another = await teams.create({ orgId: null, name: "Other viewers", createdBy: owner.id });
    expect(
      (
        await as(owner).request(`/api/canvases/${cv.id}/settings`, {
          method: "PATCH",
          headers: so,
          body: JSON.stringify({ teamIds: [another.id] }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await list(owner))
        .filter((e) => e.kind === "team")
        .map((e) => `${e.name}:${e.role}`)
        .sort(),
    ).toEqual(["Editors:editor", "Other viewers:viewer"]);
    // Switch the rung to whole org, then back to private: team grants live on the people list
    // and apply at every rung (restricted access model), so a rung change touches NEITHER row.
    const off = await as(owner).request(`/api/canvases/${cv.id}/settings`, {
      method: "PATCH",
      headers: so,
      body: JSON.stringify({ access: "whole_org" }),
    });
    expect(off.status).toBe(200);
    const back = await as(owner).request(`/api/canvases/${cv.id}/settings`, {
      method: "PATCH",
      headers: so,
      body: JSON.stringify({ access: "private" }),
    });
    expect(back.status).toBe(200);
    expect(
      (await list(owner))
        .filter((e) => e.kind === "team")
        .map((e) => `${e.name}:${e.role}`)
        .sort(),
    ).toEqual(["Editors:editor", "Other viewers:viewer"]);
    expect((await as(nobody).request(`/api/canvases/${cv.id}`)).status).toBe(200);
  });
});

// --- Ownership transfer over HTTP (editor-roles plan U7) -----------------------------------

describe("managementRoutes — POST /:id/transfer", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });
  const so = { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" } as const;

  async function seedTransfer() {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const editor = await seedUser(client, "editor");
    const viewer = await seedUser(client, "viewer");
    const nobody = await seedUser(client, "nobody");
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId: owner.id, slug: "xfer", apiKeyHash: "k" });
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    await repo.addAllowlistEntry({ canvasId: cv.id, principalKind: "member", userId: viewer.id });
    const hub = {
      calls: [] as Array<{ method: string; canvasId: string }>,
      async revalidateCanvas(canvasId: string) {
        this.calls.push({ method: "revalidateCanvas", canvasId });
      },
      async dropGatedNonOwners(canvasId: string) {
        this.calls.push({ method: "dropGatedNonOwners", canvasId });
      },
    };
    const as = (u: { id: string }) =>
      buildApp(client, { id: u.id, isAdmin: false }, undefined, hub);
    const transfer = (u: { id: string }, toUserId: string, headers: Record<string, string> = so) =>
      as(u).request(`/api/canvases/${cv.id}/transfer`, {
        method: "POST",
        headers,
        body: JSON.stringify({ toUserId }),
      });
    return { repo, cv, owner, editor, viewer, nobody, hub, as, transfer };
  }

  it("owner-only: an editor gets 403 OWNER_ONLY, viewer/no-role 404; a cross-origin request is refused before the gate (403, no OWNER_ONLY/404 signal)", async () => {
    const { editor, viewer, nobody, transfer } = await seedTransfer();
    const asEditor = await transfer(editor, viewer.id);
    expect(asEditor.status).toBe(403);
    expect((await jsonOf<{ code: string }>(asEditor)).code).toBe("OWNER_ONLY");
    expect((await transfer(viewer, editor.id)).status).toBe(404);
    expect((await transfer(nobody, editor.id)).status).toBe(404);
    const crossSite = await transfer(nobody, editor.id, {
      "Sec-Fetch-Site": "cross-site",
      "content-type": "application/json",
    });
    expect(crossSite.status).toBe(403);
    expect(JSON.stringify(await crossSite.json())).not.toContain("OWNER_ONLY");
  });

  it("AE7: owner → editor succeeds (previous owner becomes editor, sockets revalidated); to a non-editor → 409 NOT_ELIGIBLE; an email → 400", async () => {
    const { repo, cv, owner, editor, viewer, hub, as, transfer } = await seedTransfer();
    const bad = await transfer(owner, viewer.id);
    expect(bad.status).toBe(409);
    expect((await jsonOf<{ code: string }>(bad)).code).toBe("NOT_ELIGIBLE");
    expect((await transfer(owner, "editor@example.com")).status).toBe(400);
    const ok = await transfer(owner, editor.id);
    expect(ok.status).toBe(200);
    const body = await jsonOf<{
      ok: boolean;
      previousOwnerEditor: boolean;
      canvas: { id: string };
    }>(ok);
    expect(body).toMatchObject({ ok: true, previousOwnerEditor: true });
    expect((await repo.findById(cv.id))?.ownerId).toBe(editor.id);
    expect(hub.calls).toContainEqual({ method: "revalidateCanvas", canvasId: cv.id });
    // The previous owner is now an editor: manages, but delete is owner-only.
    expect((await as(owner).request(`/api/canvases/${cv.id}`)).status).toBe(200);
    const del = await as(owner).request(`/api/canvases/${cv.id}`, {
      method: "DELETE",
      headers: so,
    });
    expect(del.status).toBe(403);
    // The new owner may delete.
    expect(
      (await as(editor).request(`/api/canvases/${cv.id}`, { method: "DELETE", headers: so }))
        .status,
    ).toBe(200);
  });
});

// --- Owner entitlement gates, key rotation visibility, version creators (editor-roles plan U8) ---

describe("managementRoutes — owner entitlements, key rotation, version creators", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });
  const so = { "Sec-Fetch-Site": "same-origin", "content-type": "application/json" } as const;

  async function seedU8() {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const editor = await seedUser(client, "editor");
    const repo = canvasesRepository(client);
    const users = usersRepository(client);
    const storage = memStorage();
    const engine = deployEngine({
      config,
      canvases: repo,
      versions: versionsRepository(client),
      drafts: draftsRepository(client),
      storage,
      log: silent,
    });
    const cv = await repo.create({ ownerId: owner.id, slug: "ent", apiKeyHash: "k" });
    await engine.deploy(cv, "folder", folder({ "index.html": "<h1>v1</h1>" }), owner.id);
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    const as = (u: { id: string }, canPublishPublic = true) =>
      buildApp(client, { id: u.id, isAdmin: false, canPublishPublic }, storage);
    const patch = (u: { id: string }, body: unknown, canPublishPublic = true) =>
      as(u, canPublishPublic).request(`/api/canvases/${cv.id}/settings`, {
        method: "PATCH",
        headers: so,
        body: JSON.stringify(body),
      });
    return { repo, users, engine, cv, owner, editor, as, patch };
  }

  it("AE6: editor WITH the entitlement, owner WITHOUT → PUBLIC_LINK_OWNER_GATED; owner WITH, editor WITHOUT → editor succeeds", async () => {
    const { users, owner, editor, patch } = await seedU8();
    await users.setPublishPublic(owner.id, false);
    await users.setPublishPublic(editor.id, true);
    const gated = await patch(editor, { access: "public_link" }, true);
    expect(gated.status).toBe(403);
    expect((await jsonOf<{ code: string }>(gated)).code).toBe("PUBLIC_LINK_OWNER_GATED");
    await users.setPublishPublic(owner.id, true);
    await users.setPublishPublic(editor.id, false);
    const ok = await patch(editor, { access: "public_link" }, false);
    expect(ok.status).toBe(200);
    expect((await jsonOf<{ access: string }>(ok)).access).toBe("public_link");
  });

  it("an editor's settings save touching the guest-AI fields → 403 OWNER_ONLY; their other settings writes succeed; the owner may set them", async () => {
    const { owner, editor, patch } = await seedU8();
    const refused = await patch(editor, { guestAiEnabled: true });
    expect(refused.status).toBe(403);
    expect((await jsonOf<{ code: string }>(refused)).code).toBe("OWNER_ONLY");
    expect((await patch(editor, { guestAiCap: 2 })).status).toBe(403);
    expect((await patch(editor, { title: "by editor" })).status).toBe(200);
    expect((await patch(owner, { guestAiEnabled: true, guestAiCap: 2 })).status).toBe(200);
  });

  it("AE19: an editor regenerates the deploy key (response as today); audit meta byRole editor; the owner's rotation is byRole owner", async () => {
    const { cv, owner, editor, as } = await seedU8();
    const res = await as(editor).request(`/api/canvases/${cv.id}/regenerate-key`, {
      method: "POST",
      headers: so,
    });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ apiKey: string }>(res)).apiKey).toMatch(/^cd_/);
    await as(owner).request(`/api/canvases/${cv.id}/regenerate-key`, {
      method: "POST",
      headers: so,
    });
    const events = (await auditRepository(client).recent(20)).filter(
      (e) => e.action === "key_regen",
    );
    expect(events.map((e) => [e.actorId, (e.meta as { byRole: string }).byRole])).toEqual(
      expect.arrayContaining([
        [editor.id, "editor"],
        [owner.id, "owner"],
      ]),
    );
  });

  it("R18: versions list who created each version — an editor's publish names the editor; the owner's names the owner", async () => {
    const { repo, engine, cv, owner, editor, as } = await seedU8();
    const row = (await repo.findById(cv.id)) as NonNullable<
      Awaited<ReturnType<typeof repo.findById>>
    >;
    await engine.deploy(row, "folder", folder({ "index.html": "<h1>v2</h1>" }), editor.id);
    const res = await as(editor).request(`/api/canvases/${cv.id}/versions`);
    expect(res.status).toBe(200);
    const { versions } = await jsonOf<{
      versions: Array<{ number: number; createdBy: string; createdByName: string | null }>;
    }>(res);
    expect(versions.map((v) => [v.number, v.createdBy, v.createdByName])).toEqual([
      [2, editor.id, "editor"],
      [1, owner.id, "owner"],
    ]);
  });

  it("R11: per-canvas usage and attribution are unchanged by an editor's actions", async () => {
    const { cv, owner, editor, as } = await seedU8();
    const ownerView = await jsonOf<Record<string, unknown>>(
      await as(owner).request(`/api/canvases/${cv.id}/usage`),
    );
    const editorView = await jsonOf<Record<string, unknown>>(
      await as(editor).request(`/api/canvases/${cv.id}/usage`),
    );
    expect(editorView).toEqual(ownerView);
    // The canvas is still attributed to its owner after the editor's settings write.
    await as(editor).request(`/api/canvases/${cv.id}/settings`, {
      method: "PATCH",
      headers: so,
      body: JSON.stringify({ title: "edited" }),
    });
    expect((await canvasesRepository(client).findById(cv.id))?.ownerId).toBe(owner.id);
  });
});

// --- Owned-or-edited main list (editor-roles plan U9) --------------------------------------

describe("managementRoutes — owned-or-edited list", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("AE9: an editor's main list shows the edited canvas marked with owner + role; role filters; Shared excludes it; tags span both", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const editor = await seedUser(client, "editor");
    const repo = canvasesRepository(client);
    const own = await repo.create({ ownerId: editor.id, slug: "own", apiKeyHash: "k0" });
    const shared = await repo.create({ ownerId: owner.id, slug: "shared", apiKeyHash: "k1" });
    await repo.updateSettings(shared.id, { title: "Roadmap", tags: ["planning"] });
    await repo.addAllowlistEntry({
      canvasId: shared.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    const app = buildApp(client, { id: editor.id, isAdmin: false });
    type Row = { id: string; role: string | null; owner: { name: string } | null; ownerId: string };
    const list = async (qs = "") =>
      jsonOf<{ canvases: Row[]; total: number; summary: { owned: number; edited: number } }>(
        await app.request(`/api/canvases${qs}`),
      );
    const all = await list();
    expect(all.total).toBe(2);
    expect(all.summary).toMatchObject({ owned: 1, edited: 1 });
    const row = all.canvases.find((c) => c.id === shared.id) as Row;
    expect(row).toMatchObject({ role: "editor", ownerId: owner.id, owner: { name: "owner" } });
    expect(all.canvases.find((c) => c.id === own.id)).toMatchObject({ role: "owner" });
    expect((await list("?role=owned")).canvases.map((c) => c.id)).toEqual([own.id]);
    expect((await list("?role=edited")).canvases.map((c) => c.id)).toEqual([shared.id]);
    expect((await list("?q=roadmap")).canvases.map((c) => c.id)).toEqual([shared.id]);
    expect(
      (await jsonOf<{ tags: string[] }>(await app.request("/api/canvases/tags"))).tags,
    ).toEqual(["planning"]);
    const sharedList = await jsonOf<{ canvases: Array<{ id: string }> }>(
      await app.request("/api/canvases/shared"),
    );
    expect(sharedList.canvases.map((c) => c.id)).not.toContain(shared.id);
    // The single-canvas view carries the same identity.
    const one = await jsonOf<Row>(await app.request(`/api/canvases/${shared.id}`));
    expect(one).toMatchObject({ role: "editor", ownerId: owner.id });
  });
});

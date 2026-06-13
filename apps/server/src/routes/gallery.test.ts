import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Manifest } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { type CanvasSettingsPatch, canvasesRepository } from "../db/repositories/canvases.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { galleryRoutes } from "./gallery.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const MANIFEST: Manifest = { "index.html": { size: 10, hash: "abc", mime: "text/html" } };

interface GalleryItem {
  id: string;
  slug: string;
  url: string;
  title: string;
  summary: string | null;
  tags: string[];
  hasPassword: boolean;
  publishedAt: number | null;
  owner: { name: string; avatarUrl: string | null };
}
interface GalleryPage {
  items: GalleryItem[];
  total: number;
  limit: number;
  offset: number;
}

let seq = 0;

/** Build a gallery app authenticated as some member (the gateway is stubbed). */
function buildApp(client: DbClient, actor = { id: "viewer", isAdmin: false }) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: actor.id, isAdmin: actor.isAdmin } as never);
    await next();
  });
  app.route("/api/gallery", galleryRoutes({ config, canvases: canvasesRepository(client) }));
  return app;
}

async function seedUser(client: DbClient, name: string) {
  return usersRepository(client).upsert({
    providerSub: `sub-${seq++}`,
    email: `${name}@example.com`,
    name,
    avatarUrl: `https://avatars.example/${name}.png`,
    isAdmin: false,
  });
}

async function seedPublished(client: DbClient, ownerId: string): Promise<string> {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const n = seq++;
  const cv = await canvases.create({ ownerId, slug: `slug-${n}`, apiKeyHash: `key-${n}` });
  const v = await versions.createPending({
    canvasId: cv.id,
    number: 1,
    createdBy: ownerId,
    source: "folder",
  });
  await versions.markReady(v.id, { fileCount: 1, totalBytes: 10, manifest: MANIFEST });
  await canvases.setCurrentVersion(cv.id, v.id);
  return cv.id;
}

async function seedListed(
  client: DbClient,
  ownerId: string,
  patch: CanvasSettingsPatch = {},
): Promise<string> {
  const id = await seedPublished(client, ownerId);
  await canvasesRepository(client).updateSettings(id, {
    shared: true,
    galleryListed: true,
    gallerySummary: "A canvas",
    galleryTags: ["charts"],
    ...patch,
  });
  return id;
}

async function get(client: DbClient, path: string): Promise<{ status: number; body: GalleryPage }> {
  const res = await buildApp(client).request(path);
  return { status: res.status, body: (await res.json()) as GalleryPage };
}

describe("galleryRoutes", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("returns only listed-active-unexpired-published canvases, with owner display metadata", async () => {
    client = await makeTestDb("sqlite");
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    const repo = canvasesRepository(client);

    const listed = await seedListed(client, alice.id);
    await seedListed(client, bob.id); // a second owner's listed canvas
    await repo.updateSettings(await seedPublished(client, alice.id), { galleryListed: true }); // not shared
    await repo.updateSettings(await seedPublished(client, alice.id), { shared: true }); // not listed
    await repo.setStatus(await seedListed(client, alice.id), "disabled");
    await repo.archive(await seedListed(client, alice.id));
    await seedListed(client, alice.id, { sharedExpiresAt: 1 }); // long expired

    const { status, body } = await get(client, "/api/gallery");
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(listed);
    const item = body.items.find((i) => i.id === listed);
    expect(item?.owner.name).toBe("alice");
    expect(item?.owner.avatarUrl).toBe("https://avatars.example/alice.png");
    expect(item?.url).toContain(`/c/`);
  });

  it("never leaks sensitive owner/canvas fields (explicit projection)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    await seedListed(client, owner.id);

    const res = await buildApp(client).request("/api/gallery");
    const body = (await res.json()) as GalleryPage;
    const item = body.items[0];
    expect(item).toBeDefined();
    if (!item) return;
    // Top-level canvas fields that must never appear.
    for (const k of ["apiKeyHash", "passwordHash", "ownerId", "currentVersionId", "status"]) {
      expect(item).not.toHaveProperty(k);
    }
    // Owner sub-object is display-only — no email / internal flags.
    for (const k of ["email", "providerSub", "isAdmin", "isBlocked", "id"]) {
      expect(item.owner).not.toHaveProperty(k);
    }
  });

  it("paginates with a stable total and echoes limit/offset", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    for (let i = 0; i < 5; i++) await seedListed(client, owner.id);

    const p1 = await get(client, "/api/gallery?limit=2&offset=0");
    expect(p1.body.total).toBe(5);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.limit).toBe(2);
    expect(p1.body.offset).toBe(0);

    const last = await get(client, "/api/gallery?limit=2&offset=4");
    expect(last.body.items).toHaveLength(1);

    const beyond = await get(client, "/api/gallery?limit=2&offset=10");
    expect(beyond.body.items).toHaveLength(0);
    expect(beyond.body.total).toBe(5);
  });

  it("filters by free-text search and by tag", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const revenue = await seedListed(client, owner.id, {
      title: "Revenue chart",
      galleryTags: ["finance"],
    });
    await seedListed(client, owner.id, { title: "Game", galleryTags: ["games"] });

    const byQ = await get(client, "/api/gallery?q=revenue");
    expect(byQ.body.items.map((i) => i.id)).toEqual([revenue]);

    const byTag = await get(client, "/api/gallery?tag=finance");
    expect(byTag.body.items.map((i) => i.id)).toEqual([revenue]);

    const both = await get(client, "/api/gallery?q=revenue&tag=games");
    expect(both.body.items).toHaveLength(0);
  });

  it("lists a password-gated canvas with hasPassword and no password material", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const id = await seedListed(client, owner.id);
    await canvasesRepository(client).setPassword(id, "argon2-hash");

    const { body } = await get(client, "/api/gallery");
    const item = body.items.find((i) => i.id === id);
    expect(item?.hasPassword).toBe(true);
    expect(JSON.stringify(item)).not.toContain("argon2-hash");
  });

  it("clamps junk pagination params instead of erroring", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    await seedListed(client, owner.id);

    const huge = await get(client, "/api/gallery?limit=9999");
    expect(huge.status).toBe(200);
    expect(huge.body.limit).toBe(60); // clamped to MAX_LIMIT

    const junk = await get(client, "/api/gallery?limit=abc&offset=-5");
    expect(junk.status).toBe(200);
    expect(junk.body.limit).toBe(24); // default
    expect(junk.body.offset).toBe(0); // clamped
  });

  it("is GET-only — POST is not routed", async () => {
    client = await makeTestDb("sqlite");
    const res = await buildApp(client).request("/api/gallery", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

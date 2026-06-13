import type { Manifest } from "@canvas-drop/shared/db";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { type CanvasSettingsPatch, canvasesRepository } from "./canvases.js";
import { usersRepository } from "./users.js";
import { versionsRepository } from "./versions.js";

const MANIFEST: Manifest = { "index.html": { size: 10, hash: "abc", mime: "text/html" } };

let slugSeq = 0;
let subSeq = 0;

async function seedUser(client: DbClient, name: string) {
  return usersRepository(client).upsert({
    providerSub: `sub-${subSeq++}`,
    email: `${name}@example.com`,
    name,
    avatarUrl: `https://avatars.example/${name}.png`,
    isAdmin: false,
  });
}

/** Create a canvas owned by `ownerId` and give it a ready, current version (so it
 *  counts as "published"). Returns the canvas id. */
async function seedPublishedCanvas(client: DbClient, ownerId: string): Promise<string> {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const n = slugSeq++;
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

/** Make a published canvas and list it in the gallery with the given settings. */
async function seedListed(
  client: DbClient,
  ownerId: string,
  patch: CanvasSettingsPatch = {},
): Promise<string> {
  const id = await seedPublishedCanvas(client, ownerId);
  await canvasesRepository(client).updateSettings(id, {
    shared: true,
    galleryListed: true,
    gallerySummary: "A useful canvas",
    galleryTags: ["charts"],
    ...patch,
  });
  return id;
}

describe.each(DIALECTS)("canvasesRepository.listGallery [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  const NOW = 1_000_000;

  it("returns a fully-listed (active+shared+listed+unexpired+published) canvas", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const id = await seedListed(client, owner.id);
    const repo = canvasesRepository(client);

    const { items, total } = await repo.listGallery({ now: NOW, limit: 24, offset: 0 });
    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    const [item] = items;
    if (!item) throw new Error("expected a gallery item");
    expect(item.canvas.id).toBe(id);
    expect(item.ownerName).toBe("owner");
    expect(item.ownerAvatarUrl).toBe("https://avatars.example/owner.png");
    expect(item.canvas.gallerySummary).toBe("A useful canvas");
    expect(item.canvas.galleryTags).toEqual(["charts"]);
  });

  it("excludes a canvas for each missing visibility condition", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    // One listed canvas that SHOULD appear.
    const visible = await seedListed(client, owner.id);

    // not shared (but listed)
    await repo.updateSettings(await seedPublishedCanvas(client, owner.id), {
      galleryListed: true,
    });
    // not listed (but shared)
    await repo.updateSettings(await seedPublishedCanvas(client, owner.id), { shared: true });
    // archived
    const archived = await seedListed(client, owner.id);
    await repo.archive(archived);
    // disabled
    const disabled = await seedListed(client, owner.id);
    await repo.setStatus(disabled, "disabled");
    // deleted
    const deleted = await seedListed(client, owner.id);
    await repo.setStatus(deleted, "deleted");
    // expired in the past
    await seedListed(client, owner.id, { sharedExpiresAt: NOW - 1 });
    // never deployed (listed+shared but currentVersionId IS NULL → would be a dead link)
    const undeployedN = slugSeq++;
    const undeployed = await canvasesRepository(client).create({
      ownerId: owner.id,
      slug: `slug-${undeployedN}`,
      apiKeyHash: `key-${undeployedN}`,
    });
    await repo.updateSettings(undeployed.id, { shared: true, galleryListed: true });

    const { items, total } = await repo.listGallery({ now: NOW, limit: 24, offset: 0 });
    expect(total).toBe(1);
    expect(items.map((i) => i.canvas.id)).toEqual([visible]);
  });

  it("treats the expiry boundary as `> now` (== now is excluded)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    const future = await seedListed(client, owner.id, { sharedExpiresAt: NOW + 1 });
    await seedListed(client, owner.id, { sharedExpiresAt: NOW }); // == now → excluded
    const noExpiry = await seedListed(client, owner.id, { sharedExpiresAt: null });

    const { items } = await repo.listGallery({ now: NOW, limit: 24, offset: 0 });
    expect(items.map((i) => i.canvas.id).sort()).toEqual([future, noExpiry].sort());
  });

  it("includes a password-gated canvas (the gallery lists links, the gate enforces on open)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const id = await seedListed(client, owner.id);
    await repo.setPassword(id, "argon2-hash");

    const { items } = await repo.listGallery({ now: NOW, limit: 24, offset: 0 });
    expect(items).toHaveLength(1);
    const [item] = items;
    if (!item) throw new Error("expected a gallery item");
    expect(item.canvas.id).toBe(id);
    expect(item.canvas.passwordHash).toBe("argon2-hash");
  });

  it("surfaces the correct owner identity across owners (cross-owner join)", async () => {
    client = await makeTestDb(dialect);
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    const repo = canvasesRepository(client);
    await seedListed(client, alice.id);
    await seedListed(client, bob.id);

    const { items } = await repo.listGallery({ now: NOW, limit: 24, offset: 0 });
    const names = items.map((i) => i.ownerName).sort();
    expect(names).toEqual(["alice", "bob"]);
  });

  it("orders most-recently-published first", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const first = await seedListed(client, owner.id);
    await new Promise((r) => setTimeout(r, 2));
    const second = await seedListed(client, owner.id);
    await new Promise((r) => setTimeout(r, 2));
    const third = await seedListed(client, owner.id);

    const { items } = await repo.listGallery({ now: NOW, limit: 24, offset: 0 });
    expect(items.map((i) => i.canvas.id)).toEqual([third, second, first]);
  });

  it("paginates with a stable total", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    for (let i = 0; i < 5; i++) {
      await seedListed(client, owner.id);
      await new Promise((r) => setTimeout(r, 2));
    }

    const page1 = await repo.listGallery({ now: NOW, limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);

    const lastPage = await repo.listGallery({ now: NOW, limit: 2, offset: 4 });
    expect(lastPage.total).toBe(5);
    expect(lastPage.items).toHaveLength(1);

    const beyond = await repo.listGallery({ now: NOW, limit: 2, offset: 10 });
    expect(beyond.total).toBe(5);
    expect(beyond.items).toHaveLength(0);
  });

  it("searches title and summary case-insensitively, escaping LIKE metacharacters", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    const titled = await seedListed(client, owner.id, { title: "Quarterly Revenue" });
    await seedListed(client, owner.id, { title: "Other", gallerySummary: "team Dashboard here" });
    // A literal percent in the title must only match a literal-percent query.
    const percent = await seedListed(client, owner.id, { title: "100% coverage" });

    const byTitle = await repo.listGallery({ now: NOW, q: "revenue", limit: 24, offset: 0 });
    expect(byTitle.items.map((i) => i.canvas.id)).toEqual([titled]);

    const bySummary = await repo.listGallery({ now: NOW, q: "DASHBOARD", limit: 24, offset: 0 });
    expect(bySummary.total).toBe(1);

    // `%` is escaped → it does NOT act as a wildcard matching everything.
    const literalPercent = await repo.listGallery({ now: NOW, q: "100%", limit: 24, offset: 0 });
    expect(literalPercent.items.map((i) => i.canvas.id)).toEqual([percent]);
  });

  it("filters by exact tag membership (dialect-branched JSON query)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    const charts = await seedListed(client, owner.id, { galleryTags: ["charts", "finance"] });
    await seedListed(client, owner.id, { galleryTags: ["games"] });
    // substring of a real tag must NOT match (exact membership only)
    await seedListed(client, owner.id, { galleryTags: ["chart"] });

    const byTag = await repo.listGallery({ now: NOW, tag: "charts", limit: 24, offset: 0 });
    expect(byTag.items.map((i) => i.canvas.id)).toEqual([charts]);

    const missing = await repo.listGallery({ now: NOW, tag: "nonexistent", limit: 24, offset: 0 });
    expect(missing.items).toHaveLength(0);
  });

  it("combines search, tag, and pagination", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    const match = await seedListed(client, owner.id, {
      title: "Budget chart",
      galleryTags: ["charts"],
    });
    await seedListed(client, owner.id, { title: "Budget table", galleryTags: ["tables"] });
    await seedListed(client, owner.id, { title: "Game", galleryTags: ["charts"] });

    const { items, total } = await repo.listGallery({
      now: NOW,
      q: "budget",
      tag: "charts",
      limit: 24,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(items.map((i) => i.canvas.id)).toEqual([match]);
  });
});

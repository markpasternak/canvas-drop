import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { adminRepository } from "./admin.js";
import { canvasesRepository } from "./canvases.js";
import { filesRepository } from "./files.js";
import { usageEventsRepository } from "./usage-events.js";
import { usersRepository } from "./users.js";
import { versionsRepository } from "./versions.js";

async function seedUser(client: DbClient, sub: string) {
  return usersRepository(client).upsert({
    providerSub: sub,
    email: `${sub}@example.com`,
    name: sub,
    isAdmin: false,
  });
}

describe.each(DIALECTS)("adminRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("lists canvases across multiple owners, newest-first, excluding deleted by default", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const a = await seedUser(client, "alice");
    const b = await seedUser(client, "bob");
    const c1 = await canvases.create({ ownerId: a.id, slug: "aaa-1111-2222", apiKeyHash: "h1" });
    const c2 = await canvases.create({ ownerId: b.id, slug: "bbb-1111-2222", apiKeyHash: "h2" });
    const c3 = await canvases.create({ ownerId: a.id, slug: "ccc-1111-2222", apiKeyHash: "h3" });
    await canvases.setStatus(c2.id, "deleted");

    const admin = adminRepository(client);
    const { items, total } = await admin.listAllCanvasesFiltered({ limit: 50, offset: 0 });
    const ids = items.map((c) => c.id);
    // Both owners represented; deleted excluded; newest (c3) first.
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c3.id);
    expect(ids).not.toContain(c2.id);
    expect(ids[0]).toBe(c3.id);
    expect(total).toBe(2);
  });

  it("filters by status (e.g. the deleted-restore view)", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const a = await seedUser(client, "alice");
    const live = await canvases.create({ ownerId: a.id, slug: "live-1111-2222", apiKeyHash: "h1" });
    const gone = await canvases.create({ ownerId: a.id, slug: "gone-1111-2222", apiKeyHash: "h2" });
    await canvases.setStatus(gone.id, "deleted");

    const admin = adminRepository(client);
    const deleted = await admin.listAllCanvasesFiltered({
      limit: 50,
      offset: 0,
      status: "deleted",
    });
    expect(deleted.items.map((c) => c.id)).toEqual([gone.id]);
    const active = await admin.listAllCanvasesFiltered({ limit: 50, offset: 0, status: "active" });
    expect(active.items.map((c) => c.id)).toEqual([live.id]);
  });

  it("offset-paginates without dropping or duplicating rows", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const a = await seedUser(client, "alice");
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const cv = await canvases.create({
        ownerId: a.id,
        slug: `p${i}-1111-2222`,
        apiKeyHash: `h${i}`,
      });
      created.push(cv.id);
    }
    const admin = adminRepository(client);
    // Walk every page by offset; the union must equal all 5 ids with no dup/drop,
    // and `total` stays constant across pages.
    const seen: string[] = [];
    for (let offset = 0; offset < 10; offset += 2) {
      const { items, total } = await admin.listAllCanvasesFiltered({ limit: 2, offset });
      expect(total).toBe(5);
      if (items.length === 0) break;
      seen.push(...items.map((c) => c.id));
    }
    expect(new Set(seen).size).toBe(5); // no duplicates
    expect(seen.sort()).toEqual([...created].sort()); // no row dropped
  });

  it("searches by title, slug, and owner email (case-insensitive)", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    const ca = await canvases.create({
      ownerId: alice.id,
      slug: "alpha-1111-2222",
      apiKeyHash: "h1",
      title: "Weather Map",
    });
    const cb = await canvases.create({
      ownerId: bob.id,
      slug: "bravo-1111-2222",
      apiKeyHash: "h2",
      title: "Budget",
    });
    const admin = adminRepository(client);
    const byTitle = await admin.listAllCanvasesFiltered({ limit: 50, offset: 0, q: "WEATHER" });
    expect(byTitle.items.map((c) => c.id)).toEqual([ca.id]);
    const bySlug = await admin.listAllCanvasesFiltered({ limit: 50, offset: 0, q: "bravo" });
    expect(bySlug.items.map((c) => c.id)).toEqual([cb.id]);
    // Owner email is an OBJECT fact (the canvas's owner) — searchable.
    const byOwner = await admin.listAllCanvasesFiltered({ limit: 50, offset: 0, q: "alice@" });
    expect(byOwner.items.map((c) => c.id)).toEqual([ca.id]);
    expect(byOwner.total).toBe(1);
  });

  it("restricts to a single owner (drill-down)", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    const ca = await canvases.create({ ownerId: alice.id, slug: "aa-1111-2222", apiKeyHash: "h1" });
    await canvases.create({ ownerId: bob.id, slug: "bb-1111-2222", apiKeyHash: "h2" });
    const admin = adminRepository(client);
    const res = await admin.listAllCanvasesFiltered({ limit: 50, offset: 0, owner: alice.id });
    expect(res.items.map((c) => c.id)).toEqual([ca.id]);
    expect(res.total).toBe(1);
  });

  it("sorts by title A–Z and by created (newest first)", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const a = await seedUser(client, "alice");
    const zebra = await canvases.create({
      ownerId: a.id,
      slug: "z-1111-2222",
      apiKeyHash: "h1",
      title: "Zebra",
    });
    const apple = await canvases.create({
      ownerId: a.id,
      slug: "a-1111-2222",
      apiKeyHash: "h2",
      title: "Apple",
    });
    const admin = adminRepository(client);
    const byTitle = await admin.listAllCanvasesFiltered({ limit: 50, offset: 0, sort: "title" });
    expect(byTitle.items.map((c) => c.title)).toEqual(["Apple", "Zebra"]);
    const byCreated = await admin.listAllCanvasesFiltered({
      limit: 50,
      offset: 0,
      sort: "created",
    });
    expect(byCreated.items.map((c) => c.id)).toEqual([apple.id, zebra.id]);
  });

  it("listUsers returns per-user canvas counts (excluding deleted), with search + sort", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    await canvases.create({ ownerId: alice.id, slug: "a1-1111-2222", apiKeyHash: "h1" });
    const a2 = await canvases.create({ ownerId: alice.id, slug: "a2-1111-2222", apiKeyHash: "h2" });
    await canvases.setStatus(a2.id, "deleted"); // soft-deleted → excluded from the count
    const admin = adminRepository(client);

    const all = await admin.listUsers({ limit: 50, offset: 0, sort: "canvases" });
    expect(all.total).toBe(2);
    expect(all.items.find((u) => u.id === alice.id)?.canvasCount).toBe(1);
    expect(all.items.find((u) => u.id === bob.id)?.canvasCount).toBe(0);
    // sort=canvases → alice (1 canvas) ranks before bob (0).
    expect(all.items[0]?.id).toBe(alice.id);

    const searched = await admin.listUsers({ limit: 50, offset: 0, q: "bob@" });
    expect(searched.items.map((u) => u.id)).toEqual([bob.id]);
    expect(searched.total).toBe(1);
  });

  it("platformStats: counts by status, user count, file bytes, top canvases", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const files = filesRepository(client);
    const usage = usageEventsRepository(client);
    const a = await seedUser(client, "alice");
    const b = await seedUser(client, "bob");
    const c1 = await canvases.create({ ownerId: a.id, slug: "one-1111-2222", apiKeyHash: "h1" });
    const c2 = await canvases.create({ ownerId: b.id, slug: "two-1111-2222", apiKeyHash: "h2" });
    await canvases.setDisabled(c2.id, "spam");
    await files.insert({
      id: "f1",
      canvasId: c1.id,
      filename: "a.png",
      mime: "image/png",
      sizeBytes: 1000,
      storageKey: "k1",
      uploadedBy: a.id,
    });
    await files.insert({
      id: "f2",
      canvasId: c1.id,
      filename: "b.png",
      mime: "image/png",
      sizeBytes: 500,
      storageKey: "k2",
      uploadedBy: a.id,
    });
    await usage.record({ canvasId: c1.id, userId: a.id, type: "kv_op" });
    await usage.record({ canvasId: c1.id, userId: a.id, type: "kv_op" });
    await usage.record({ canvasId: c2.id, userId: b.id, type: "file_op" });

    const stats = await adminRepository(client).platformStats(5);
    expect(stats.canvasCountByStatus.active).toBe(1);
    expect(stats.canvasCountByStatus.disabled).toBe(1);
    expect(stats.userCount).toBe(2);
    expect(stats.totalFileBytes).toBe(1500);
    expect(stats.topCanvases[0]).toEqual({ canvasId: c1.id, ops: 2 });
    // Expanded stats: total ops across the platform; growth counts; no purge backlog yet.
    expect(stats.totalOps).toBe(3);
    expect(stats.newCanvases).toBe(2); // both just created → inside the window
    expect(stats.newUsers).toBe(2);
    expect(stats.recentWindowDays).toBe(7);
    expect(stats.oldestDeletedAt).toBeNull(); // c2 is disabled, not deleted
  });

  it("platformStats: counts views, unique viewers, and READY deploys (not pending) — both dialects", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const usage = usageEventsRepository(client);
    const versions = versionsRepository(client);
    const a = await seedUser(client, "alice");
    const b = await seedUser(client, "bob");
    const cv = await canvases.create({ ownerId: a.id, slug: "viewed-1111-2222", apiKeyHash: "h1" });

    // Two distinct viewers → 2 views, 2 unique viewers (recordView dedups per viewer/window).
    const now = Date.now();
    await usage.recordView({ canvasId: cv.id, userId: a.id, windowMs: 1000, now });
    await usage.recordView({ canvasId: cv.id, userId: b.id, windowMs: 1000, now });

    // One ready version (a real deploy) + one pending build that never went live.
    const ready = await versions.createPending({
      canvasId: cv.id,
      number: 1,
      createdBy: a.id,
      source: "api",
    });
    await versions.markReady(ready.id, { fileCount: 1, totalBytes: 1, manifest: {} });
    await versions.createPending({ canvasId: cv.id, number: 2, createdBy: a.id, source: "api" });

    const stats = await adminRepository(client).platformStats(5);
    expect(stats.totalViews).toBe(2);
    expect(stats.uniqueViewers).toBe(2);
    // Pending builds are not deploys — only the ready version counts (regression for
    // the totalDeploys ready-filter).
    expect(stats.totalDeploys).toBe(1);
  });

  it("platformStats: recent-window counts respect the cutoff; oldestDeletedAt tracks purge backlog", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const a = await seedUser(client, "alice");
    const fresh = await canvases.create({ ownerId: a.id, slug: "new-1111-2222", apiKeyHash: "h1" });
    const gone = await canvases.create({ ownerId: a.id, slug: "del-1111-2222", apiKeyHash: "h2" });
    await canvases.setStatus(gone.id, "deleted");

    const admin = adminRepository(client);
    // Anchor "now" far in the future so the just-created rows fall OUTSIDE the 7-day window.
    const farFuture = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const stats = await admin.platformStats(5, farFuture);
    expect(stats.newCanvases).toBe(0);
    expect(stats.newUsers).toBe(0);
    // A soft-deleted canvas exists → oldestDeletedAt is its deletedAt stamp (a number).
    expect(typeof stats.oldestDeletedAt).toBe("number");
    expect(stats.oldestDeletedAt).toBeLessThanOrEqual(Date.now());

    // With "now" at creation time, both rows are inside the window.
    const nowStats = await admin.platformStats(5, Date.now());
    expect(nowStats.newCanvases).toBe(2);
    expect(fresh.id).toBeTruthy();
  });

  it("platformStats on an EMPTY platform returns numeric zeros (no null/NaN sum)", async () => {
    client = await makeTestDb(dialect);
    const stats = await adminRepository(client).platformStats(5);
    expect(stats.totalFileBytes).toBe(0);
    expect(typeof stats.totalFileBytes).toBe("number");
    expect(stats.userCount).toBe(0);
    expect(stats.topCanvases).toEqual([]);
  });

  it("usageCountByCanvas batches op counts (empty list short-circuits)", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const usage = usageEventsRepository(client);
    const a = await seedUser(client, "alice");
    const c1 = await canvases.create({ ownerId: a.id, slug: "one-1111-2222", apiKeyHash: "h1" });
    await usage.record({ canvasId: c1.id, userId: a.id, type: "kv_op" });
    await usage.record({ canvasId: c1.id, userId: a.id, type: "kv_op" });
    const admin = adminRepository(client);
    expect(await admin.usageCountByCanvas([])).toEqual(new Map());
    const map = await admin.usageCountByCanvas([c1.id]);
    expect(map.get(c1.id)).toBe(2);
  });
});

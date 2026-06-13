import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { adminRepository } from "./admin.js";
import { canvasesRepository } from "./canvases.js";
import { filesRepository } from "./files.js";
import { usageEventsRepository } from "./usage-events.js";
import { usersRepository } from "./users.js";

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
    const list = await admin.listAllCanvases({ limit: 50 });
    const ids = list.map((c) => c.id);
    // Both owners represented; deleted excluded; newest (c3) first.
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c3.id);
    expect(ids).not.toContain(c2.id);
    expect(ids[0]).toBe(c3.id);
  });

  it("filters by status (e.g. the deleted-restore view)", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const a = await seedUser(client, "alice");
    const live = await canvases.create({ ownerId: a.id, slug: "live-1111-2222", apiKeyHash: "h1" });
    const gone = await canvases.create({ ownerId: a.id, slug: "gone-1111-2222", apiKeyHash: "h2" });
    await canvases.setStatus(gone.id, "deleted");

    const admin = adminRepository(client);
    const deleted = await admin.listAllCanvases({ limit: 50, status: "deleted" });
    expect(deleted.map((c) => c.id)).toEqual([gone.id]);
    const active = await admin.listAllCanvases({ limit: 50, status: "active" });
    expect(active.map((c) => c.id)).toEqual([live.id]);
  });

  it("keyset-paginates on createdAt via the cursor", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const a = await seedUser(client, "alice");
    for (let i = 0; i < 3; i++) {
      await canvases.create({ ownerId: a.id, slug: `p${i}-1111-2222`, apiKeyHash: `h${i}` });
    }
    const admin = adminRepository(client);
    const page1 = await admin.listAllCanvases({ limit: 2 });
    expect(page1).toHaveLength(2);
    const cursor = page1[page1.length - 1]?.createdAt ?? 0;
    const page2 = await admin.listAllCanvases({ limit: 2, cursor });
    // No overlap; page2 continues strictly older than the page1 cursor.
    const p1ids = new Set(page1.map((c) => c.id));
    expect(page2.every((c) => !p1ids.has(c.id))).toBe(true);
    expect(page2.every((c) => c.createdAt < cursor)).toBe(true);
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

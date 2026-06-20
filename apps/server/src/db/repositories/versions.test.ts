import type { Manifest } from "@canvas-drop/shared/db";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { usersRepository } from "./users.js";
import { versionsRepository } from "./versions.js";

const MANIFEST: Manifest = { "index.html": { size: 10, hash: "abc", mime: "text/html" } };

async function seedCanvas(client: DbClient): Promise<{ canvasId: string; userId: string }> {
  const u = await usersRepository(client).upsert({
    providerSub: "o",
    email: "o@example.com",
    name: "O",
    isAdmin: false,
  });
  const cv = await canvasesRepository(client).create({
    ownerId: u.id,
    slug: "s",
    apiKeyHash: "h",
  });
  return { canvasId: cv.id, userId: u.id };
}

describe.each(DIALECTS)("versionsRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("nextNumber returns 1 for a fresh canvas, then max+1", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seedCanvas(client);
    const repo = versionsRepository(client);
    expect(await repo.nextNumber(canvasId)).toBe(1);
    await repo.createPending({ canvasId, number: 1, createdBy: userId, source: "folder" });
    expect(await repo.nextNumber(canvasId)).toBe(2);
  });

  it("createPending → markReady persists manifest, counts, and status", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seedCanvas(client);
    const repo = versionsRepository(client);
    const v = await repo.createPending({ canvasId, number: 1, createdBy: userId, source: "zip" });
    expect(v.status).toBe("pending");
    const ready = await repo.markReady(v.id, { fileCount: 1, totalBytes: 10, manifest: MANIFEST });
    expect(ready.status).toBe("ready");
    expect(ready.fileCount).toBe(1);
    expect(ready.manifest).toEqual(MANIFEST);
  });

  it("number uniqueness is per-canvas (same number allowed across canvases)", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seedCanvas(client);
    const repo = versionsRepository(client);
    await repo.createPending({ canvasId, number: 1, createdBy: userId, source: "folder" });
    await expect(
      repo.createPending({ canvasId, number: 1, createdBy: userId, source: "folder" }),
    ).rejects.toThrow();
    // a different canvas may reuse number 1
    const other = await canvasesRepository(client).create({
      ownerId: userId,
      slug: "s2",
      apiKeyHash: "h2", // distinct: api_key_hash is now unique-indexed
    });
    await expect(
      repo.createPending({ canvasId: other.id, number: 1, createdBy: userId, source: "folder" }),
    ).resolves.toBeDefined();
  });

  it("lists deploy history newest-first and finds ready versions by number", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seedCanvas(client);
    const repo = versionsRepository(client);
    for (const n of [1, 2, 3]) {
      const v = await repo.createPending({ canvasId, number: n, createdBy: userId, source: "api" });
      await repo.markReady(v.id, { fileCount: 1, totalBytes: 1, manifest: MANIFEST });
    }
    const history = await repo.listByCanvas(canvasId);
    expect(history.map((v) => v.number)).toEqual([3, 2, 1]);
    expect((await repo.findReadyByNumber(canvasId, 2))?.number).toBe(2);
    expect(await repo.findReadyByNumber(canvasId, 99)).toBeNull();
  });

  it("findByIds returns [] for empty input and the matching rows otherwise", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seedCanvas(client);
    const repo = versionsRepository(client);
    // empty input must not hit the DB / emit `in ()`
    expect(await repo.findByIds([])).toEqual([]);
    const a = await repo.createPending({ canvasId, number: 1, createdBy: userId, source: "api" });
    const b = await repo.createPending({ canvasId, number: 2, createdBy: userId, source: "api" });
    const found = await repo.findByIds([a.id, b.id, "missing"]);
    expect(found.map((v) => v.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("pruneBeyond keeps newest N, never drops the live current version", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seedCanvas(client);
    const repo = versionsRepository(client);
    const canvases = canvasesRepository(client);
    const ids: string[] = [];
    for (let n = 1; n <= 12; n++) {
      const v = await repo.createPending({ canvasId, number: n, createdBy: userId, source: "api" });
      await repo.markReady(v.id, { fileCount: 1, totalBytes: 1, manifest: MANIFEST });
      ids.push(v.id);
    }
    // current = version 12 (newest); pruneBeyond(10) drops the 2 oldest (1, 2)
    await canvases.setCurrentVersion(canvasId, ids[11] as string);
    const dropped = await repo.pruneBeyond(canvasId, 10);
    expect(dropped.map((v) => v.number).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(await repo.findById(ids[0] as string)).toBeNull();
    expect((await repo.listByCanvas(canvasId)).length).toBe(10);

    // if the current version is old (still present: 3..12), it is never pruned
    await canvases.setCurrentVersion(canvasId, ids[5] as string); // current = #6
    const dropped2 = await repo.pruneBeyond(canvasId, 5);
    expect(dropped2.find((v) => v.id === ids[5])).toBeUndefined();
    expect(await repo.findById(ids[5] as string)).not.toBeNull();
  });

  it("rollback-vs-prune race: pruneBeyond spares a version a concurrent rollback just made current", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seedCanvas(client);
    const repo = versionsRepository(client);
    const canvases = canvasesRepository(client);
    const ids: string[] = [];
    for (let n = 1; n <= 12; n++) {
      const v = await repo.createPending({ canvasId, number: n, createdBy: userId, source: "api" });
      await repo.markReady(v.id, { fileCount: 1, totalBytes: 1, manifest: MANIFEST });
      ids.push(v.id);
    }
    // A rollback makes v1 (oldest — in the prune drop range for keep=10) current,
    // racing a concurrent deploy's prune. The atomic live-pointer re-read inside
    // the DELETE must spare v1, even though a stale snapshot would have dropped it.
    await canvases.setCurrentVersion(canvasId, ids[0] as string);
    const dropped = await repo.pruneBeyond(canvasId, 10);
    // Only v2 (beyond newest-10 AND not current) is dropped; v1 survives.
    expect(dropped.map((v) => v.number)).toEqual([2]);
    expect(await repo.findById(ids[0] as string)).not.toBeNull();
    // The pointer is NOT dangling — it still resolves to a ready version.
    const live = await canvases.findById(canvasId);
    const cur = live?.currentVersionId ? await repo.findById(live.currentVersionId) : null;
    expect(cur?.status).toBe("ready");
  });

  it("pruneBeyond handles a canvas with no current version (no NULL poisoning)", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seedCanvas(client);
    const repo = versionsRepository(client);
    for (let n = 1; n <= 12; n++) {
      const v = await repo.createPending({ canvasId, number: n, createdBy: userId, source: "api" });
      await repo.markReady(v.id, { fileCount: 1, totalBytes: 1, manifest: MANIFEST });
    }
    // currentVersionId is null → the notInArray subquery is empty → all candidates drop.
    const dropped = await repo.pruneBeyond(canvasId, 10);
    expect(dropped.map((v) => v.number).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("deletePending removes a pending row by id but never a ready one (status-guarded)", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seedCanvas(client);
    const repo = versionsRepository(client);
    const pending = await repo.createPending({
      canvasId,
      number: 1,
      createdBy: userId,
      source: "api",
    });
    const readyPending = await repo.createPending({
      canvasId,
      number: 2,
      createdBy: userId,
      source: "api",
    });
    const ready = await repo.markReady(readyPending.id, {
      fileCount: 1,
      totalBytes: 1,
      manifest: MANIFEST,
    });

    // Removes the pending row…
    await repo.deletePending(pending.id);
    expect(await repo.findById(pending.id)).toBeNull();
    // …but a ready row is untouched even when its id is passed (the status guard).
    await repo.deletePending(ready.id);
    expect((await repo.findById(ready.id))?.status).toBe("ready");
  });

  it("deletePendingBefore sweeps pending rows older than the cutoff, never a ready row", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seedCanvas(client);
    const repo = versionsRepository(client);
    const pending = await repo.createPending({
      canvasId,
      number: 1,
      createdBy: userId,
      source: "api",
    });
    const readyPending = await repo.createPending({
      canvasId,
      number: 2,
      createdBy: userId,
      source: "api",
    });
    await repo.markReady(readyPending.id, { fileCount: 1, totalBytes: 1, manifest: MANIFEST });
    const createdAt = (await repo.findById(pending.id))?.createdAt ?? 0;

    // A cutoff AT createdAt (strict `<`) spares the row — an in-flight deploy is safe.
    expect(await repo.deletePendingBefore(canvasId, createdAt)).toBe(0);
    expect((await repo.findById(pending.id))?.status).toBe("pending");

    // A cutoff past it sweeps the pending row — but never the ready one, even though
    // the far-future cutoff covers its timestamp too (the status filter spares it).
    expect(await repo.deletePendingBefore(canvasId, createdAt + 1_000_000)).toBe(1);
    expect(await repo.findById(pending.id)).toBeNull();
    expect((await repo.findById(readyPending.id))?.status).toBe("ready");
  });
});

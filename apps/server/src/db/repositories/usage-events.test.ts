import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { usageEventsRepository } from "./usage-events.js";
import { usersRepository } from "./users.js";

async function seed(client: DbClient): Promise<{ canvasId: string; userId: string }> {
  const u = await usersRepository(client).upsert({
    providerSub: "owner",
    email: "owner@example.com",
    name: "owner",
    isAdmin: false,
  });
  const cv = await canvasesRepository(client).create({
    ownerId: u.id,
    slug: "s",
    apiKeyHash: "h",
  });
  return { canvasId: cv.id, userId: u.id };
}

describe.each(DIALECTS)("usageEventsRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("records events and counts them by type", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = usageEventsRepository(client);
    await repo.record({ canvasId, userId, type: "kv_op", meta: { op: "set" } });
    await repo.record({ canvasId, userId, type: "kv_op", meta: { op: "get" } });
    await repo.record({ canvasId, userId, type: "file_op", meta: { op: "upload" } });

    const counts = await repo.countByType(canvasId, null);
    expect(counts.kv_op).toBe(2);
    expect(counts.file_op).toBe(1);
  });

  it("countByType honors the since window and scopes by canvas", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const other = await canvasesRepository(client).create({
      ownerId: userId,
      slug: "other",
      apiKeyHash: "h2",
    });
    const repo = usageEventsRepository(client);
    await repo.record({ canvasId, userId, type: "kv_op" });
    await repo.record({ canvasId: other.id, userId, type: "kv_op" });

    // a future cutoff excludes the just-written rows
    expect(await repo.countByType(canvasId, Date.now() + 60_000)).toEqual({});
    // canvas scoping: only this canvas's events
    expect((await repo.countByType(canvasId, null)).kv_op).toBe(1);
  });

  it("pruneBefore deletes rows older than the cutoff and keeps newer ones", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = usageEventsRepository(client);
    await repo.record({ canvasId, userId, type: "kv_op" });
    const cutoff = Date.now() + 1; // everything so far is "before" this
    await new Promise((r) => setTimeout(r, 2));
    await repo.record({ canvasId, userId, type: "kv_op" });

    const removed = await repo.pruneBefore(cutoff);
    expect(removed).toBe(1);
    expect((await repo.countByType(canvasId, null)).kv_op).toBe(1);
  });

  it("a failing record rejects (callers wrap fire-and-forget) — sane error surface", async () => {
    client = await makeTestDb(dialect);
    const repo = usageEventsRepository(client);
    // FK violation: canvas/user don't exist → the insert rejects. Routes call this
    // fire-and-forget so it never reaches the request path.
    await expect(
      repo.record({ canvasId: "nope", userId: "nope", type: "kv_op" }),
    ).rejects.toBeDefined();
  });

  it("recordView dedupes within the session window and re-records after it", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = usageEventsRepository(client);
    const t0 = 1_700_000_000_000;
    const win = 60_000;
    // First load → inserts.
    expect(await repo.recordView({ canvasId, userId, windowMs: win, now: t0 })).toBe(true);
    // Refresh inside the window → no new row.
    expect(await repo.recordView({ canvasId, userId, windowMs: win, now: t0 + 30_000 })).toBe(
      false,
    );
    // Return after the window → a new view.
    expect(await repo.recordView({ canvasId, userId, windowMs: win, now: t0 + 90_000 })).toBe(true);
    expect((await repo.countByType(canvasId, null)).view).toBe(2);
  });

  it("a counted view bumps the canvas view rollups; a deduped refresh does not (plan 004)", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = usageEventsRepository(client);
    const canvases = canvasesRepository(client);
    const t0 = 1_700_000_000_000;
    const win = 60_000;

    expect(await repo.recordView({ canvasId, userId, windowMs: win, now: t0 })).toBe(true);
    let cv = await canvases.findById(canvasId);
    expect(cv?.viewCount).toBe(1);
    expect(cv?.lastViewedAt).toBe(t0);

    // Refresh inside the window → no new event, so the rollups must NOT move.
    expect(await repo.recordView({ canvasId, userId, windowMs: win, now: t0 + 30_000 })).toBe(
      false,
    );
    cv = await canvases.findById(canvasId);
    expect(cv?.viewCount).toBe(1);
    expect(cv?.lastViewedAt).toBe(t0);

    // A new session → bump again, last-viewed advances.
    expect(await repo.recordView({ canvasId, userId, windowMs: win, now: t0 + 90_000 })).toBe(true);
    cv = await canvases.findById(canvasId);
    expect(cv?.viewCount).toBe(2);
    expect(cv?.lastViewedAt).toBe(t0 + 90_000);
  });

  it("recentViewCounts groups view counts per canvas within the window (plan 004)", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const other = await canvasesRepository(client).create({
      ownerId: userId,
      slug: "other",
      apiKeyHash: "h2",
    });
    const viewerB = await usersRepository(client).upsert({
      providerSub: "b",
      email: "b@example.com",
      name: "B",
      isAdmin: false,
    });
    const repo = usageEventsRepository(client);
    const t0 = 1_700_000_000_000;
    const win = 60_000;
    // canvasId: 1 old view out-of-window (A), then 2 in-window (A new session, B).
    await repo.recordView({ canvasId, userId, windowMs: win, now: t0 - 2 * win });
    await repo.recordView({ canvasId, userId, windowMs: win, now: t0 });
    await repo.recordView({ canvasId, userId: viewerB.id, windowMs: win, now: t0 + win });
    // other: 1 view in-window.
    await repo.recordView({ canvasId: other.id, userId, windowMs: win, now: t0 });
    // Noise that must not count as a view.
    await repo.record({ canvasId, userId, type: "kv_op" });

    // since just below t0 excludes the t0-2*win view, capturing only the two recent ones.
    const counts = await repo.recentViewCounts([canvasId, other.id], t0 - 1);
    expect(counts.get(canvasId)).toBe(2);
    expect(counts.get(other.id)).toBe(1);
    // Empty input → no query, empty map. Unknown ids are simply absent.
    expect((await repo.recentViewCounts([], t0 - 1)).size).toBe(0);
    expect((await repo.recentViewCounts(["nope"], t0 - 1)).has("nope")).toBe(false);
  });

  it("viewStats returns total, unique viewers, and last-viewed; excludes non-view types", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const viewerB = await usersRepository(client).upsert({
      providerSub: "b",
      email: "b@example.com",
      name: "B",
      isAdmin: false,
    });
    const repo = usageEventsRepository(client);
    const t0 = 1_700_000_000_000;
    const win = 60_000;
    // A views twice across two sessions, B views once → 3 views / 2 unique.
    await repo.recordView({ canvasId, userId, windowMs: win, now: t0 });
    await repo.recordView({ canvasId, userId, windowMs: win, now: t0 + 2 * win });
    await repo.recordView({ canvasId, userId: viewerB.id, windowMs: win, now: t0 + win });
    // Noise that must not count as a view.
    await repo.record({ canvasId, userId, type: "kv_op" });

    const stats = await repo.viewStats(canvasId);
    expect(stats.totalViews).toBe(3);
    expect(stats.uniqueViewers).toBe(2);
    expect(stats.lastViewedAt).toBe(t0 + 2 * win);
  });

  it("viewStats reports zeros and null last-viewed for a canvas with no views", async () => {
    client = await makeTestDb(dialect);
    const { canvasId } = await seed(client);
    const stats = await usageEventsRepository(client).viewStats(canvasId);
    expect(stats).toEqual({ totalViews: 0, uniqueViewers: 0, lastViewedAt: null });
  });

  it("viewsByDay returns a dense UTC-day series with correct per-day counts", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const viewerB = await usersRepository(client).upsert({
      providerSub: "b",
      email: "b@example.com",
      name: "B",
      isAdmin: false,
    });
    const repo = usageEventsRepository(client);
    const DAY = 24 * 60 * 60 * 1000;
    const day0 = 1_700_000_000_000 - (1_700_000_000_000 % DAY); // a UTC midnight
    const win = 60_000;
    // day0: two viewers; day2: one viewer; day1: none.
    await repo.recordView({ canvasId, userId, windowMs: win, now: day0 + 1_000 });
    await repo.recordView({ canvasId, userId: viewerB.id, windowMs: win, now: day0 + 2_000 });
    await repo.recordView({ canvasId, userId, windowMs: win, now: day0 + 2 * DAY + 1_000 });

    const series = await repo.viewsByDay(canvasId, day0, day0 + 2 * DAY + 5_000);
    expect(series).toEqual([
      { dayMs: day0, count: 2 },
      { dayMs: day0 + DAY, count: 0 },
      { dayMs: day0 + 2 * DAY, count: 1 },
    ]);
  });

  it("viewsByDay places events on either side of a UTC midnight in different buckets", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const viewerB = await usersRepository(client).upsert({
      providerSub: "b",
      email: "b@example.com",
      name: "B",
      isAdmin: false,
    });
    const repo = usageEventsRepository(client);
    const DAY = 24 * 60 * 60 * 1000;
    const midnight = 1_700_000_000_000 - (1_700_000_000_000 % DAY) + DAY;
    await repo.recordView({ canvasId, userId, windowMs: 60_000, now: midnight - 1 });
    await repo.recordView({ canvasId, userId: viewerB.id, windowMs: 60_000, now: midnight + 1 });
    const series = await repo.viewsByDay(canvasId, midnight - DAY, midnight + 1);
    expect(series).toEqual([
      { dayMs: midnight - DAY, count: 1 },
      { dayMs: midnight, count: 1 },
    ]);
  });
});

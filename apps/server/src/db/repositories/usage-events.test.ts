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
});

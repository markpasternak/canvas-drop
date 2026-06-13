import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { KvNotNumericError, kvRepository } from "./kv.js";
import { usersRepository } from "./users.js";

async function seed(client: DbClient): Promise<{ canvasId: string; userId: string }> {
  const u = await usersRepository(client).upsert({
    providerSub: "owner",
    email: "owner@example.com",
    name: "owner",
    isAdmin: false,
  });
  const cv = await canvasesRepository(client).create({ ownerId: u.id, slug: "s", apiKeyHash: "h" });
  return { canvasId: cv.id, userId: u.id };
}

describe.each(DIALECTS)("kvRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("set→get round-trips JSON; set overwrites + updates attribution", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const kv = kvRepository(client);
    await kv.set(canvasId, "shared", "k", { a: 1 }, userId);
    expect(await kv.get(canvasId, "shared", "k")).toEqual({ a: 1 });
    await kv.set(canvasId, "shared", "k", [1, 2, 3], userId);
    expect(await kv.get(canvasId, "shared", "k")).toEqual([1, 2, 3]);
  });

  it("delete removes; get on a missing key returns null", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const kv = kvRepository(client);
    await kv.set(canvasId, "shared", "k", 1, userId);
    await kv.delete(canvasId, "shared", "k");
    expect(await kv.get(canvasId, "shared", "k")).toBeNull();
  });

  it("list filters by prefix, paginates by cursor, stable key order", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const kv = kvRepository(client);
    for (const k of ["a:1", "a:2", "a:3", "b:1"]) await kv.set(canvasId, "shared", k, 0, userId);
    const page1 = await kv.list(canvasId, "shared", { prefix: "a:", limit: 2 });
    expect(page1.entries.map((e) => e.key)).toEqual(["a:1", "a:2"]);
    expect(page1.nextCursor).toBe("a:2");
    const page2 = await kv.list(canvasId, "shared", { prefix: "a:", cursor: "a:2", limit: 2 });
    expect(page2.entries.map((e) => e.key)).toEqual(["a:3"]);
    expect(page2.nextCursor).toBeNull();
    // prefix excludes b:
    expect((await kv.list(canvasId, "shared", { prefix: "a:" })).entries).toHaveLength(3);
  });

  it("increment: missing starts at by; sequential accumulates; returns new total", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const kv = kvRepository(client);
    expect(await kv.increment(canvasId, "shared", "n", 5, userId)).toBe(5);
    expect(await kv.increment(canvasId, "shared", "n", 3, userId)).toBe(8);
    expect(await kv.get(canvasId, "shared", "n")).toBe(8);
  });

  it("increment: concurrent calls converge to the correct total (no lost update — R2)", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const kv = kvRepository(client);
    await Promise.all(
      Array.from({ length: 50 }, () => kv.increment(canvasId, "shared", "votes", 1, userId)),
    );
    expect(await kv.get(canvasId, "shared", "votes")).toBe(50);
  });

  it("increment: present non-numeric value is rejected", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const kv = kvRepository(client);
    await kv.set(canvasId, "shared", "s", "hello", userId);
    await expect(kv.increment(canvasId, "shared", "s", 1, userId)).rejects.toBeInstanceOf(
      KvNotNumericError,
    );
  });

  it("shared vs per-user scope are independent rows", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const kv = kvRepository(client);
    await kv.set(canvasId, "shared", "k", "shared-val", userId);
    await kv.set(canvasId, userId, "k", "user-val", userId);
    expect(await kv.get(canvasId, "shared", "k")).toBe("shared-val");
    expect(await kv.get(canvasId, userId, "k")).toBe("user-val");
  });

  it("countKeys reflects inserts/deletes per scope", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const kv = kvRepository(client);
    await kv.set(canvasId, "shared", "a", 1, userId);
    await kv.set(canvasId, "shared", "b", 1, userId);
    await kv.set(canvasId, userId, "a", 1, userId);
    expect(await kv.countKeys(canvasId, "shared")).toBe(2);
    expect(await kv.countKeys(canvasId, userId)).toBe(1);
    await kv.delete(canvasId, "shared", "a");
    expect(await kv.countKeys(canvasId, "shared")).toBe(1);
  });

  it("keys are isolated across canvases", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const other = await canvasesRepository(client).create({
      ownerId: userId,
      slug: "other",
      apiKeyHash: "h2",
    });
    const kv = kvRepository(client);
    await kv.set(canvasId, "shared", "k", "A", userId);
    expect(await kv.get(other.id, "shared", "k")).toBeNull();
  });
});

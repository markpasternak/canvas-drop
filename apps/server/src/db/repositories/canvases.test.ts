import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { usersRepository } from "./users.js";
import { versionsRepository } from "./versions.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function seedOwner(client: DbClient, sub = "owner"): Promise<string> {
  const u = await usersRepository(client).upsert({
    providerSub: sub,
    email: `${sub}@example.com`,
    name: sub,
    isAdmin: false,
  });
  return u.id;
}

describe.each(DIALECTS)("canvasesRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("creates a canvas with a UUIDv7 id and active status", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "quiet-otter-x7k2", apiKeyHash: "h" });
    expect(cv.id).toMatch(UUID_RE);
    expect(cv.slug).toBe("quiet-otter-x7k2");
    expect(cv.status).toBe("active");
    expect(cv.shared).toBe(false);
    expect(cv.currentVersionId).toBeNull();
  });

  it("enforces slug uniqueness", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    await repo.create({ ownerId, slug: "dup", apiKeyHash: "h" });
    await expect(repo.create({ ownerId, slug: "dup", apiKeyHash: "h2" })).rejects.toThrow();
  });

  it("finds by slug and id; excludes soft-deleted from find-by-slug", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s1", apiKeyHash: "h" });
    expect((await repo.findBySlug("s1"))?.id).toBe(cv.id);
    expect((await repo.findById(cv.id))?.slug).toBe("s1");
    await repo.setStatus(cv.id, "deleted");
    expect(await repo.findBySlug("s1")).toBeNull();
    expect(await repo.findById(cv.id)).not.toBeNull(); // still findable by id
  });

  it("lists a user's canvases newest-first, excluding deleted", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const a = await repo.create({ ownerId, slug: "a", apiKeyHash: "h" });
    const b = await repo.create({ ownerId, slug: "b", apiKeyHash: "h" });
    await repo.setStatus(a.id, "deleted");
    const list = await repo.listByOwner(ownerId);
    expect(list.map((c) => c.id)).toEqual([b.id]);
  });

  it("updates settings: shared toggle sets shared_at; expiry persists", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    const shared = await repo.updateSettings(cv.id, { shared: true, sharedExpiresAt: 9999 });
    expect(shared.shared).toBe(true);
    expect(shared.sharedAt).toBeGreaterThan(0);
    expect(shared.sharedExpiresAt).toBe(9999);
    const unshared = await repo.updateSettings(cv.id, { shared: false });
    expect(unshared.shared).toBe(false);
    expect(unshared.sharedAt).toBeNull();
  });

  it("setPassword bumps passwordVersion (invalidates gate cookies)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    expect(cv.passwordVersion).toBe(0);
    const withPw = await repo.setPassword(cv.id, "argon2hash");
    expect(withPw.passwordHash).toBe("argon2hash");
    expect(withPw.passwordVersion).toBe(1);
    const cleared = await repo.setPassword(cv.id, null);
    expect(cleared.passwordHash).toBeNull();
    expect(cleared.passwordVersion).toBe(2);
  });

  it("regenerates slug (old no longer resolves) and api key", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "old", apiKeyHash: "oldhash" });
    await repo.regenerateSlug(cv.id, "new");
    expect(await repo.findBySlug("old")).toBeNull();
    expect((await repo.findBySlug("new"))?.id).toBe(cv.id);
    await repo.regenerateApiKey(cv.id, "newhash");
    expect((await repo.findById(cv.id))?.apiKeyHash).toBe("newhash");
    expect(await repo.findByApiKeyHash("oldhash")).toBeNull();
    expect((await repo.findByApiKeyHash("newhash"))?.id).toBe(cv.id);
  });

  it("findByApiKeyHash returns only active canvases", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "k" });
    expect((await repo.findByApiKeyHash("k"))?.id).toBe(cv.id);
    await repo.setStatus(cv.id, "disabled");
    expect(await repo.findByApiKeyHash("k")).toBeNull();
  });

  it("setCurrentVersionIfReady swaps to a ready version, refuses a pending/missing one", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const versions = versionsRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "k" });
    const ready = await versions.createPending({
      canvasId: cv.id,
      number: 1,
      createdBy: ownerId,
      source: "api",
    });
    await versions.markReady(ready.id, { fileCount: 1, totalBytes: 1, manifest: {} });
    const pending = await versions.createPending({
      canvasId: cv.id,
      number: 2,
      createdBy: ownerId,
      source: "api",
    });

    // ready → swap succeeds and the pointer moves
    expect(await repo.setCurrentVersionIfReady(cv.id, ready.id)).toBe(true);
    expect((await repo.findById(cv.id))?.currentVersionId).toBe(ready.id);
    // pending (not ready) → refused, pointer unchanged (no dangling pointer)
    expect(await repo.setCurrentVersionIfReady(cv.id, pending.id)).toBe(false);
    expect((await repo.findById(cv.id))?.currentVersionId).toBe(ready.id);
    // missing version id (raced-away / pruned) → refused, pointer unchanged
    expect(await repo.setCurrentVersionIfReady(cv.id, "does-not-exist")).toBe(false);
    expect((await repo.findById(cv.id))?.currentVersionId).toBe(ready.id);
  });
});

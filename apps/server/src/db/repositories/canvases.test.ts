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

  it("lists a user's canvases newest-first, excluding deleted and archived", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const a = await repo.create({ ownerId, slug: "a", apiKeyHash: "ha" });
    const b = await repo.create({ ownerId, slug: "b", apiKeyHash: "hb" });
    const c = await repo.create({ ownerId, slug: "c", apiKeyHash: "hc" });
    await repo.setStatus(a.id, "deleted");
    await repo.archive(c.id);
    const list = await repo.listByOwner(ownerId);
    expect(list.map((cv) => cv.id)).toEqual([b.id]); // not deleted, not archived
  });

  it("archives an active canvas without touching deletedAt; archive-view lists it", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    expect(await repo.archive(cv.id)).toBe(true);
    const after = await repo.findById(cv.id);
    expect(after?.status).toBe("archived");
    expect(after?.deletedAt).toBeNull(); // archive is not delete
    const archived = await repo.listArchivedByOwner(ownerId);
    expect(archived.map((c) => c.id)).toEqual([cv.id]);
    expect(await repo.listByOwner(ownerId)).toEqual([]); // gone from the active view
  });

  it("does NOT archive a disabled canvas (admin takedown can't be self-rescued, §12.0 #5)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    await repo.setDisabled(cv.id, "policy");
    // Archive is guarded to `active` only — an owner can't archive→unarchive a
    // disabled canvas back to active and reverse the takedown.
    expect(await repo.archive(cv.id)).toBe(false);
    expect((await repo.findById(cv.id))?.status).toBe("disabled");
  });

  it("does not archive a deleted canvas (no tombstone resurrection)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    await repo.setStatus(cv.id, "deleted");
    expect(await repo.archive(cv.id)).toBe(false);
    expect((await repo.findById(cv.id))?.status).toBe("deleted");
  });

  it("unarchives back to active, preserving settings", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    await repo.updateSettings(cv.id, { shared: true });
    await repo.setPassword(cv.id, "argon2hash");
    await repo.archive(cv.id);
    expect(await repo.unarchive(cv.id)).toBe(true);
    const after = await repo.findById(cv.id);
    expect(after?.status).toBe("active");
    expect(after?.shared).toBe(true); // share + password survive the round-trip
    expect(after?.passwordHash).toBe("argon2hash");
    expect(after?.slug).toBe("s");
  });

  it("unarchive on a non-archived canvas is a guarded no-op (false)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    expect(await repo.unarchive(cv.id)).toBe(false); // active, not archived
    expect((await repo.findById(cv.id))?.status).toBe("active");
    await repo.setStatus(cv.id, "disabled");
    expect(await repo.unarchive(cv.id)).toBe(false); // disabled is not archived
    expect((await repo.findById(cv.id))?.status).toBe("disabled");
  });

  it("setDisabled takes an active canvas down with a reason; enable clears it (M7)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    expect(await repo.setDisabled(cv.id, "abusive content")).toBe(true);
    const down = await repo.findById(cv.id);
    expect(down?.status).toBe("disabled");
    expect(down?.disabledReason).toBe("abusive content");
    expect(await repo.enable(cv.id)).toBe(true);
    const up = await repo.findById(cv.id);
    expect(up?.status).toBe("active");
    expect(up?.disabledReason).toBeNull(); // reason cleared, no stale note
  });

  it("setDisabled is guarded: a non-active (archived/deleted) canvas returns false", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    await repo.archive(cv.id);
    expect(await repo.setDisabled(cv.id, "x")).toBe(false); // archived, not active
    expect((await repo.findById(cv.id))?.status).toBe("archived");
    const del = await repo.create({ ownerId, slug: "s2", apiKeyHash: "h2" });
    await repo.setStatus(del.id, "deleted");
    expect(await repo.setDisabled(del.id, "x")).toBe(false); // deleted, not active
  });

  it("enable on a non-disabled canvas is a guarded no-op (false)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    expect(await repo.enable(cv.id)).toBe(false); // active, not disabled
    expect((await repo.findById(cv.id))?.status).toBe("active");
  });

  it("restore brings a soft-deleted canvas back to active and clears deletedAt (M7)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    await repo.setStatus(cv.id, "deleted");
    expect((await repo.findById(cv.id))?.deletedAt).not.toBeNull();
    expect(await repo.restore(cv.id)).toBe(true);
    const back = await repo.findById(cv.id);
    expect(back?.status).toBe("active");
    expect(back?.deletedAt).toBeNull();
    // A non-deleted canvas can't be "restored".
    expect(await repo.restore(cv.id)).toBe(false);
  });

  it("findByApiKeyHash excludes archived (deploys blocked while archived)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "k" });
    await repo.archive(cv.id);
    expect(await repo.findByApiKeyHash("k")).toBeNull();
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

  it("create defaults: backend off, all feature flags on (plan 006)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "caps-default", apiKeyHash: "h" });
    expect(cv.backendEnabled).toBe(false);
    expect(cv.capKv).toBe(true);
    expect(cv.capFiles).toBe(true);
    expect(cv.capAi).toBe(true);
    expect(cv.capRealtime).toBe(true);
  });

  it("create honors backendEnabled:true (features still default on)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({
      ownerId,
      slug: "caps-on",
      apiKeyHash: "h",
      backendEnabled: true,
    });
    expect(cv.backendEnabled).toBe(true);
    expect(cv.capKv).toBe(true);
    expect(cv.capRealtime).toBe(true);
  });

  it("updateCapabilities toggles a single feature, leaving others intact", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({
      ownerId,
      slug: "caps-patch",
      apiKeyHash: "h",
      backendEnabled: true,
    });
    const updated = await repo.updateCapabilities(cv.id, { ai: false });
    expect(updated.capAi).toBe(false);
    expect(updated.capKv).toBe(true);
    expect(updated.capFiles).toBe(true);
    expect(updated.capRealtime).toBe(true);
    expect(updated.backendEnabled).toBe(true);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(cv.updatedAt);
  });

  it("turning backend off preserves feature flags (KTD-2)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({
      ownerId,
      slug: "caps-ktd2",
      apiKeyHash: "h",
      backendEnabled: true,
    });
    await repo.updateCapabilities(cv.id, { kv: false });
    const off = await repo.updateCapabilities(cv.id, { backendEnabled: false });
    expect(off.backendEnabled).toBe(false);
    expect(off.capKv).toBe(false); // preserved, not reset
    expect(off.capFiles).toBe(true);
    // re-enabling restores the prior per-feature choices
    const back = await repo.updateCapabilities(cv.id, { backendEnabled: true });
    expect(back.capKv).toBe(false);
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

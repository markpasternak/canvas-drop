import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository, type OwnerListOptions } from "./canvases.js";
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

/** Give a canvas a ready published version (so it counts as "deployed"). */
async function deploy(
  client: DbClient,
  canvasId: string,
  ownerId: string,
  number = 1,
): Promise<void> {
  const versions = versionsRepository(client);
  const v = await versions.createPending({ canvasId, number, createdBy: ownerId, source: "api" });
  await versions.markReady(v.id, { fileCount: 1, totalBytes: 1, manifest: {} });
  await canvasesRepository(client).setCurrentVersion(canvasId, v.id);
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
    const list = (await repo.listByOwnerFiltered({ ownerId, limit: 100, offset: 0 })).items;
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
    expect((await repo.listByOwnerFiltered({ ownerId, limit: 100, offset: 0 })).items).toEqual([]); // gone from the active view
    // The Active/Archived toggle: `archived` scope lists ONLY archived canvases.
    const arch = await repo.listByOwnerFiltered({ ownerId, archived: true, limit: 100, offset: 0 });
    expect(arch.items.map((c) => c.id)).toEqual([cv.id]);
    expect(arch.total).toBe(1);
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

  it("unpublishes a published canvas → clears the version pointer AND gallery listing", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "pub-1", apiKeyHash: "h" });
    await deploy(client, cv.id, ownerId);
    await repo.updateSettings(cv.id, {
      shared: true,
      galleryListed: true,
      galleryTemplatable: true,
    });

    expect(await repo.unpublish(cv.id)).toBe(true);
    const after = await repo.findById(cv.id);
    expect(after?.status).toBe("active"); // still active + editable, just Draft now
    expect(after?.currentVersionId).toBeNull();
    expect(after?.shared).toBe(false); // leaving Published reverts share
    expect(after?.galleryListed).toBe(false);
    expect(after?.galleryTemplatable).toBe(false);
  });

  it("re-publishing after unpublish does NOT auto-restore sharing (owner re-shares deliberately)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "re-1", apiKeyHash: "h" });
    await deploy(client, cv.id, ownerId, 1);
    await repo.updateSettings(cv.id, { shared: true });
    await repo.unpublish(cv.id);
    // Re-publish by pointing at a fresh ready version (what a new deploy does).
    await deploy(client, cv.id, ownerId, 2);
    const after = await repo.findById(cv.id);
    expect(after?.currentVersionId).not.toBeNull(); // published again
    expect(after?.shared).toBe(false); // sharing was NOT silently restored
  });

  it("archive reverts share + gallery (leaving Published)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "sh-1", apiKeyHash: "h" });
    await deploy(client, cv.id, ownerId);
    await repo.updateSettings(cv.id, {
      shared: true,
      galleryListed: true,
      galleryTemplatable: true,
    });

    expect(await repo.archive(cv.id)).toBe(true);
    const after = await repo.findById(cv.id);
    expect(after?.status).toBe("archived");
    expect(after?.shared).toBe(false);
    expect(after?.galleryListed).toBe(false);
    expect(after?.galleryTemplatable).toBe(false);
    expect(after?.currentVersionId).not.toBeNull(); // version pointer kept for unarchive
  });

  it("does NOT unpublish a draft / archived / disabled canvas (guarded transition)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    // Draft (active, never published) → no current version → false.
    const draft = await repo.create({ ownerId, slug: "d-1", apiKeyHash: "h" });
    expect(await repo.unpublish(draft.id)).toBe(false);
    // Archived published → false (unarchive first).
    const arch = await repo.create({ ownerId, slug: "a-1", apiKeyHash: "h2" });
    await deploy(client, arch.id, ownerId);
    await repo.archive(arch.id);
    expect(await repo.unpublish(arch.id)).toBe(false);
    expect((await repo.findById(arch.id))?.currentVersionId).not.toBeNull(); // untouched
    // Disabled published → false.
    const dis = await repo.create({ ownerId, slug: "x-1", apiKeyHash: "h3" });
    await deploy(client, dis.id, ownerId);
    await repo.setDisabled(dis.id, "policy");
    expect(await repo.unpublish(dis.id)).toBe(false);
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

  it("unarchives back to active — keeps password + slug, but share/gallery stay reverted", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    await deploy(client, cv.id, ownerId);
    await repo.updateSettings(cv.id, { shared: true });
    await repo.setPassword(cv.id, "argon2hash");
    await repo.archive(cv.id); // reverts share (invariant: shared ⟹ published)
    expect(await repo.unarchive(cv.id)).toBe(true);
    const after = await repo.findById(cv.id);
    expect(after?.status).toBe("active");
    expect(after?.shared).toBe(false); // archive reverted share; owner re-shares deliberately
    expect(after?.passwordHash).toBe("argon2hash"); // password + slug survive the round-trip
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

  it("restore brings a soft-deleted canvas back to active, clearing deletedAt AND any stale disabledReason (M7)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedOwner(client);
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId, slug: "s", apiKeyHash: "h" });
    // Disabled → deleted: a stale takedown reason must NOT survive a restore onto
    // the active row (would launder a takedown into a live canvas, §12.0 #5).
    await repo.setDisabled(cv.id, "abuse");
    await repo.setStatus(cv.id, "deleted");
    expect((await repo.findById(cv.id))?.deletedAt).not.toBeNull();
    expect(await repo.restore(cv.id)).toBe(true);
    const back = await repo.findById(cv.id);
    expect(back?.status).toBe("active");
    expect(back?.deletedAt).toBeNull();
    expect(back?.disabledReason).toBeNull(); // stale reason cleared
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

  // ── listByOwnerFiltered (plan 005) ───────────────────────────────────────

  it("listByOwnerFiltered returns only the caller's active canvases (owner-scope invariant)", async () => {
    client = await makeTestDb(dialect);
    const me = await seedOwner(client, "me");
    const other = await seedOwner(client, "other");
    const repo = canvasesRepository(client);
    const mine = await repo.create({ ownerId: me, slug: "mine", apiKeyHash: "k-mine" });
    const archived = await repo.create({ ownerId: me, slug: "arch", apiKeyHash: "k-arch" });
    const deleted = await repo.create({ ownerId: me, slug: "del", apiKeyHash: "k-del" });
    await repo.create({ ownerId: other, slug: "theirs", apiKeyHash: "k-theirs" });
    await repo.archive(archived.id);
    await repo.setStatus(deleted.id, "deleted");

    // Even with all state filters off (the most permissive call), only my one
    // active canvas comes back — never another owner's, never archived/deleted.
    const { items, total } = await repo.listByOwnerFiltered({ ownerId: me, limit: 50, offset: 0 });
    expect(items.map((c) => c.id)).toEqual([mine.id]);
    expect(total).toBe(1);
  });

  it("listByOwnerFiltered searches title and slug case-insensitively, escaping LIKE metacharacters", async () => {
    client = await makeTestDb(dialect);
    const me = await seedOwner(client, "me");
    const repo = canvasesRepository(client);
    await repo.create({
      ownerId: me,
      slug: "weather-app",
      apiKeyHash: "k1",
      title: "Weather Dashboard",
    });
    await repo.create({ ownerId: me, slug: "budget-tool", apiKeyHash: "k2", title: "Budget" });
    await repo.create({ ownerId: me, slug: "ab", apiKeyHash: "k3", title: "100% Coverage" });

    // Title match, case-insensitive.
    expect(
      (
        await repo.listByOwnerFiltered({ ownerId: me, q: "WEATHER", limit: 50, offset: 0 })
      ).items.map((c) => c.slug),
    ).toEqual(["weather-app"]);
    // Slug match.
    expect(
      (
        await repo.listByOwnerFiltered({ ownerId: me, q: "budget-", limit: 50, offset: 0 })
      ).items.map((c) => c.slug),
    ).toEqual(["budget-tool"]);
    // A literal "%" is escaped — matches the "100%" title, not everything.
    const pct = await repo.listByOwnerFiltered({ ownerId: me, q: "100%", limit: 50, offset: 0 });
    expect(pct.items.map((c) => c.slug)).toEqual(["ab"]);
  });

  it("listByOwnerFiltered applies each state filter in isolation", async () => {
    client = await makeTestDb(dialect);
    const me = await seedOwner(client, "me");
    const repo = canvasesRepository(client);
    const plain = await repo.create({ ownerId: me, slug: "plain", apiKeyHash: "k-plain" });
    const shared = await repo.create({ ownerId: me, slug: "shared", apiKeyHash: "k-shared" });
    const prot = await repo.create({ ownerId: me, slug: "prot", apiKeyHash: "k-prot" });
    const listed = await repo.create({ ownerId: me, slug: "listed", apiKeyHash: "k-listed" });
    const tmpl = await repo.create({ ownerId: me, slug: "tmpl", apiKeyHash: "k-tmpl" });
    await repo.updateSettings(shared.id, { shared: true });
    await repo.setPassword(prot.id, "argon2hash");
    await repo.updateSettings(listed.id, { galleryListed: true });
    await repo.updateSettings(tmpl.id, { galleryTemplatable: true });
    // `plain` and one other are deployed; the rest are never-deployed.
    await deploy(client, plain.id, me);

    const ids = async (opts: Partial<OwnerListOptions>) =>
      (await repo.listByOwnerFiltered({ ownerId: me, limit: 50, offset: 0, ...opts })).items
        .map((c) => c.id)
        .sort();

    expect(await ids({ shared: true })).toEqual([shared.id].sort());
    expect(await ids({ protected: true })).toEqual([prot.id].sort());
    expect(await ids({ listed: true })).toEqual([listed.id].sort());
    expect(await ids({ template: true })).toEqual([tmpl.id].sort());
    // never-deployed = everything except the one deployed canvas.
    expect(await ids({ neverDeployed: true })).toEqual(
      [shared.id, prot.id, listed.id, tmpl.id].sort(),
    );
  });

  it("ownerSummary counts only the caller's current inventory facets", async () => {
    client = await makeTestDb(dialect);
    const me = await seedOwner(client, "me");
    const other = await seedOwner(client, "other");
    const repo = canvasesRepository(client);

    const deployed = await repo.create({ ownerId: me, slug: "deployed", apiKeyHash: "k1" });
    const shared = await repo.create({ ownerId: me, slug: "shared", apiKeyHash: "k2" });
    const protectedCanvas = await repo.create({ ownerId: me, slug: "protected", apiKeyHash: "k3" });
    const listed = await repo.create({ ownerId: me, slug: "listed", apiKeyHash: "k4" });
    const template = await repo.create({ ownerId: me, slug: "template", apiKeyHash: "k5" });
    const archived = await repo.create({ ownerId: me, slug: "archived", apiKeyHash: "k6" });
    const deleted = await repo.create({ ownerId: me, slug: "deleted", apiKeyHash: "k7" });
    await repo.create({ ownerId: other, slug: "other", apiKeyHash: "ko" });

    await deploy(client, deployed.id, me);
    await repo.updateSettings(shared.id, { shared: true });
    await repo.setPassword(protectedCanvas.id, "argon2hash");
    await repo.updateSettings(listed.id, { galleryListed: true });
    await repo.updateSettings(template.id, { galleryListed: true, galleryTemplatable: true });
    await repo.archive(archived.id);
    await repo.setStatus(deleted.id, "deleted");

    await expect(repo.ownerSummary(me)).resolves.toEqual({
      active: 5,
      archived: 1,
      shared: 1,
      protected: 1,
      listed: 2,
      templates: 1,
      neverDeployed: 4,
    });
  });

  it("listByOwnerFiltered intersects composed filters", async () => {
    client = await makeTestDb(dialect);
    const me = await seedOwner(client, "me");
    const repo = canvasesRepository(client);
    const both = await repo.create({ ownerId: me, slug: "both", apiKeyHash: "k-both" });
    const sharedOnly = await repo.create({ ownerId: me, slug: "shared-only", apiKeyHash: "k-so" });
    const tmplOnly = await repo.create({ ownerId: me, slug: "tmpl-only", apiKeyHash: "k-to" });
    await repo.updateSettings(both.id, { shared: true, galleryTemplatable: true });
    await repo.updateSettings(sharedOnly.id, { shared: true });
    await repo.updateSettings(tmplOnly.id, { galleryTemplatable: true });

    const { items, total } = await repo.listByOwnerFiltered({
      ownerId: me,
      shared: true,
      template: true,
      limit: 50,
      offset: 0,
    });
    expect(items.map((c) => c.id)).toEqual([both.id]);
    expect(total).toBe(1);
  });

  it("listByOwnerFiltered sorts by title (A–Z) and created (newest-first)", async () => {
    client = await makeTestDb(dialect);
    const me = await seedOwner(client, "me");
    const repo = canvasesRepository(client);
    const a = await repo.create({ ownerId: me, slug: "a", apiKeyHash: "ka", title: "Banana" });
    const b = await repo.create({ ownerId: me, slug: "b", apiKeyHash: "kb", title: "apple" });
    const c = await repo.create({ ownerId: me, slug: "c", apiKeyHash: "kc", title: "Cherry" });

    // Title sort is case-insensitive A–Z: apple, Banana, Cherry.
    expect(
      (
        await repo.listByOwnerFiltered({ ownerId: me, sort: "title", limit: 50, offset: 0 })
      ).items.map((cv) => cv.title),
    ).toEqual(["apple", "Banana", "Cherry"]);
    // Created sort is newest-first (uuidv7 id tiebreak makes it deterministic).
    expect(
      (
        await repo.listByOwnerFiltered({ ownerId: me, sort: "created", limit: 50, offset: 0 })
      ).items.map((cv) => cv.id),
    ).toEqual([c.id, b.id, a.id]);
  });

  it("listByOwnerFiltered windows with limit/offset while total reflects the full filtered count", async () => {
    client = await makeTestDb(dialect);
    const me = await seedOwner(client, "me");
    const repo = canvasesRepository(client);
    for (let i = 0; i < 5; i++) {
      await repo.create({ ownerId: me, slug: `c${i}`, apiKeyHash: `k${i}`, title: `t${i}` });
    }
    const page = await repo.listByOwnerFiltered({
      ownerId: me,
      sort: "title",
      limit: 2,
      offset: 2,
    });
    expect(page.items.map((c) => c.title)).toEqual(["t2", "t3"]);
    expect(page.total).toBe(5); // full count, independent of the window
  });

  it("listByOwnerFiltered returns an empty page (not an error) when nothing matches", async () => {
    client = await makeTestDb(dialect);
    const me = await seedOwner(client, "me");
    const repo = canvasesRepository(client);
    await repo.create({ ownerId: me, slug: "only", apiKeyHash: "h" });
    const res = await repo.listByOwnerFiltered({
      ownerId: me,
      q: "no-such-canvas",
      limit: 50,
      offset: 0,
    });
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });
});

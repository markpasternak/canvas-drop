import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import {
  seedListed,
  seedPublishedCanvas,
  seedUndeployedCanvas,
  seedUser,
} from "./gallery-test-helpers.js";
import { usageEventsRepository } from "./usage-events.js";

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
    expect(item.canvas.description).toBe("A useful canvas");
    expect(item.canvas.tags).toEqual(["charts"]);
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
    await repo.updateSettings(await seedPublishedCanvas(client, owner.id), { access: "whole_org" });
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
    const undeployed = await seedUndeployedCanvas(client, owner.id);
    await repo.updateSettings(undeployed, { access: "whole_org", galleryListed: true });

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

  it("EXCLUDES a password-protected canvas (plan 002: protected canvases are not listable)", async () => {
    // Reverses the M8 decision — a password gate now makes a canvas invisible in
    // the gallery (the `password_hash IS NULL` predicate clause), so a protected
    // canvas is never handed out as a gallery link.
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const id = await seedListed(client, owner.id);
    await repo.setPassword(id, "argon2-hash");

    const { items, total } = await repo.listGallery({ now: NOW, limit: 24, offset: 0 });
    expect(items).toHaveLength(0);
    expect(total).toBe(0);
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
    // Created oldest→newest. gallery_published_at is newest-first; on a same-ms tie
    // the `desc(id)` tiebreak (uuidv7 is monotonic) keeps newest-first too.
    const first = await seedListed(client, owner.id);
    const second = await seedListed(client, owner.id);
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
    await seedListed(client, owner.id, { title: "Other", description: "team Dashboard here" });
    // A literal percent in the title must only match a literal-percent query.
    const percent = await seedListed(client, owner.id, { title: "100% coverage" });
    // A literal underscore must match literally, not as a single-char wildcard.
    const underscore = await seedListed(client, owner.id, { title: "Q1_Revenue" });

    const byTitle = await repo.listGallery({ now: NOW, q: "revenue", limit: 24, offset: 0 });
    // "revenue" matches both "Quarterly Revenue" and "Q1_Revenue".
    expect(byTitle.items.map((i) => i.canvas.id).sort()).toEqual([titled, underscore].sort());

    const bySummary = await repo.listGallery({ now: NOW, q: "DASHBOARD", limit: 24, offset: 0 });
    expect(bySummary.total).toBe(1);

    // `%` is escaped → it does NOT act as a wildcard matching everything.
    const literalPercent = await repo.listGallery({ now: NOW, q: "100%", limit: 24, offset: 0 });
    expect(literalPercent.items.map((i) => i.canvas.id)).toEqual([percent]);

    // `_` is escaped → "Q1_R" matches only the literal underscore, not "Q1XR".
    await seedListed(client, owner.id, { title: "Q1XRevenue" });
    const literalUnderscore = await repo.listGallery({ now: NOW, q: "q1_r", limit: 24, offset: 0 });
    expect(literalUnderscore.items.map((i) => i.canvas.id)).toEqual([underscore]);
  });

  it("filters by exact tag membership (dialect-branched JSON query)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    const charts = await seedListed(client, owner.id, { tags: ["charts", "finance"] });
    await seedListed(client, owner.id, { tags: ["games"] });
    // substring of a real tag must NOT match (exact membership only)
    await seedListed(client, owner.id, { tags: ["chart"] });

    const byTag = await repo.listGallery({ now: NOW, tag: ["charts"], limit: 24, offset: 0 });
    expect(byTag.items.map((i) => i.canvas.id)).toEqual([charts]);

    const missing = await repo.listGallery({
      now: NOW,
      tag: ["nonexistent"],
      limit: 24,
      offset: 0,
    });
    expect(missing.items).toHaveLength(0);
  });

  it("combines search, tag, and pagination", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    const match = await seedListed(client, owner.id, {
      title: "Budget chart",
      tags: ["charts"],
    });
    await seedListed(client, owner.id, { title: "Budget table", tags: ["tables"] });
    await seedListed(client, owner.id, { title: "Game", tags: ["charts"] });

    const { items, total } = await repo.listGallery({
      now: NOW,
      q: "budget",
      tag: ["charts"],
      limit: 24,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(items.map((i) => i.canvas.id)).toEqual([match]);
  });

  // --- plan 004: owner/templatable filters, sort, owner id ---

  it("exposes the opaque owner id on each row (plan 004)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    await seedListed(client, owner.id);

    const { items } = await repo.listGallery({ now: NOW, limit: 24, offset: 0 });
    expect(items[0]?.ownerId).toBe(owner.id);
  });

  it("filters by owner id", async () => {
    client = await makeTestDb(dialect);
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    const repo = canvasesRepository(client);
    const aliceCanvas = await seedListed(client, alice.id);
    await seedListed(client, bob.id);

    const { items, total } = await repo.listGallery({
      now: NOW,
      owner: alice.id,
      limit: 24,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(items.map((i) => i.canvas.id)).toEqual([aliceCanvas]);
  });

  it("filters by templatable", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const templatable = await seedListed(client, owner.id, { galleryTemplatable: true });
    await seedListed(client, owner.id, { galleryTemplatable: false });

    const { items, total } = await repo.listGallery({
      now: NOW,
      templatable: true,
      limit: 24,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(items.map((i) => i.canvas.id)).toEqual([templatable]);
  });

  it("owner/templatable filters AND onto the visibility predicate — cannot widen it (§12)", async () => {
    client = await makeTestDb(dialect);
    const alice = await seedUser(client, "alice");
    const repo = canvasesRepository(client);

    // alice has one fully-visible canvas and several that fail a visibility clause.
    const visible = await seedListed(client, alice.id, { galleryTemplatable: true });
    // unshared (fails shared=true)
    await repo.updateSettings(await seedPublishedCanvas(client, alice.id), {
      galleryListed: true,
      galleryTemplatable: true,
    });
    // unlisted (fails gallery_listed)
    await repo.updateSettings(await seedPublishedCanvas(client, alice.id), {
      access: "whole_org",
      galleryTemplatable: true,
    });
    // protected (fails password_hash IS NULL)
    const protectedId = await seedListed(client, alice.id, { galleryTemplatable: true });
    await repo.setPassword(protectedId, "argon2-hash");
    // never deployed (fails current_version_id IS NOT NULL)
    const undeployed = await seedUndeployedCanvas(client, alice.id);
    await repo.updateSettings(undeployed, {
      access: "whole_org",
      galleryListed: true,
      galleryTemplatable: true,
    });

    // Filtering by alice's owner id AND templatable must still return ONLY the one
    // visible canvas — no filter combination can surface a non-visible row.
    const { items, total } = await repo.listGallery({
      now: NOW,
      owner: alice.id,
      templatable: true,
      limit: 24,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(items.map((i) => i.canvas.id)).toEqual([visible]);
  });

  it("sorts by title case-insensitively (plan 004)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const banana = await seedListed(client, owner.id, { title: "Banana" });
    const apple = await seedListed(client, owner.id, { title: "apple" });
    const cherry = await seedListed(client, owner.id, { title: "Cherry" });

    const { items } = await repo.listGallery({ now: NOW, sort: "title", limit: 24, offset: 0 });
    // Case-insensitive A–Z: apple, Banana, Cherry — NOT ASCII order (which would
    // put the lowercase 'apple' last).
    expect(items.map((i) => i.canvas.id)).toEqual([apple, banana, cherry]);
  });

  it("sorts by last-updated, distinct from published order (plan 004)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const first = await seedListed(client, owner.id);
    const second = await seedListed(client, owner.id);
    const third = await seedListed(client, owner.id);

    // Re-touch `first` after a real clock gap so its updated_at is strictly newest
    // while its published order stays oldest — proving `updated` ≠ `published`.
    await new Promise((r) => setTimeout(r, 5));
    await repo.updateSettings(first, { description: "touched" });

    const published = await repo.listGallery({ now: NOW, sort: "published", limit: 24, offset: 0 });
    expect(published.items.map((i) => i.canvas.id)).toEqual([third, second, first]);

    const updated = await repo.listGallery({ now: NOW, sort: "updated", limit: 24, offset: 0 });
    expect(updated.items[0]?.canvas.id).toBe(first);
  });

  // --- 2026-06-19: multi-tag any-match, featured field/filter/sort, trending ---

  it("multi-tag is any-match and URL-shareable (?tag=a&tag=b)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    const charts = await seedListed(client, owner.id, { tags: ["charts"] });
    const games = await seedListed(client, owner.id, { tags: ["games"] });
    await seedListed(client, owner.id, { tags: ["tables"] });

    // ANY-match: a canvas matches if it carries EITHER selected tag.
    const { items, total } = await repo.listGallery({
      now: NOW,
      tag: ["charts", "games"],
      limit: 24,
      offset: 0,
    });
    expect(total).toBe(2);
    expect(new Set(items.map((i) => i.canvas.id))).toEqual(new Set([charts, games]));
  });

  it("exposes galleryFeatured on every row and filters to featured-only (published+listed)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const featured = await seedListed(client, owner.id, { title: "Featured one" });
    const plain = await seedListed(client, owner.id, { title: "Plain one" });
    await repo.setFeatured(featured, true);

    // galleryFeatured is present on every gallery row (display flag for the badge).
    const all = await repo.listGallery({ now: NOW, limit: 24, offset: 0 });
    const byId = new Map(all.items.map((i) => [i.canvas.id, i.canvas.galleryFeatured]));
    expect(byId.get(featured)).toBe(true);
    expect(byId.get(plain)).toBe(false);

    // The featured filter returns ONLY listed+published+featured canvases.
    const { items, total } = await repo.listGallery({
      now: NOW,
      featured: true,
      limit: 24,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(items.map((i) => i.canvas.id)).toEqual([featured]);
  });

  it("sort=featured puts admin-featured canvases first, then recent", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const first = await seedListed(client, owner.id);
    const second = await seedListed(client, owner.id);
    const third = await seedListed(client, owner.id);
    // Feature the OLDEST-published one — featured must still float to the top.
    await repo.setFeatured(first, true);

    const { items } = await repo.listGallery({ now: NOW, sort: "featured", limit: 24, offset: 0 });
    // featured first; the rest fall back to recent (published desc): third, second.
    expect(items.map((i) => i.canvas.id)).toEqual([first, third, second]);
  });

  it("a stale galleryFeatured never surfaces a non-visible canvas (featured filter + sort=featured AND the visibility predicate)", async () => {
    // §12: galleryFeatured is a display/ordering flag, NOT a visibility grant. A canvas
    // that was listed+published+featured and then UNLISTED keeps galleryFeatured=true
    // (stale), but the gallery visibility predicate (gallery_listed) must still exclude it.
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    // Visible: listed + published + featured → DOES appear.
    const visible = await seedListed(client, owner.id, { title: "Visible featured" });
    await repo.setFeatured(visible, true);

    // Stale: featured, but then unlisted (galleryFeatured stays true). MUST NOT appear.
    const stale = await seedListed(client, owner.id, { title: "Stale featured" });
    await repo.setFeatured(stale, true);
    await repo.updateSettings(stale, { galleryListed: false });

    // The featured FILTER returns only the still-visible featured canvas.
    const filtered = await repo.listGallery({ now: NOW, featured: true, limit: 24, offset: 0 });
    expect(filtered.total).toBe(1);
    expect(filtered.items.map((i) => i.canvas.id)).toEqual([visible]);

    // sort=featured floats featured to the top but can never surface a non-visible row.
    const sorted = await repo.listGallery({ now: NOW, sort: "featured", limit: 24, offset: 0 });
    expect(sorted.items.map((i) => i.canvas.id)).toEqual([visible]);
  });

  it("sort=recent matches sort=published (publishedAt desc)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const first = await seedListed(client, owner.id);
    const second = await seedListed(client, owner.id);
    const third = await seedListed(client, owner.id);

    const recent = await repo.listGallery({ now: NOW, sort: "recent", limit: 24, offset: 0 });
    expect(recent.items.map((i) => i.canvas.id)).toEqual([third, second, first]);
  });

  it("sort=trending orders by recent views and hydrates recentViews on every row", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const usage = usageEventsRepository(client);
    const cold = await seedListed(client, owner.id);
    const warm = await seedListed(client, owner.id);
    const hot = await seedListed(client, owner.id);

    // Distinct viewers (the 30-min dedup is per-viewer) so each view counts.
    const viewN = async (canvasId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await usage.recordView({ canvasId, userId: `viewer-${i}`, windowMs: 60_000, now: NOW });
      }
    };
    await viewN(hot, 3);
    await viewN(warm, 1);
    // cold: zero views

    const trendingSinceMs = NOW - 1_000;
    const { items, total } = await repo.listGallery({
      now: NOW,
      sort: "trending",
      trendingSinceMs,
      limit: 24,
      offset: 0,
    });
    expect(total).toBe(3);
    expect(items.map((i) => i.canvas.id)).toEqual([hot, warm, cold]);
    expect(items.map((i) => i.recentViews)).toEqual([3, 1, 0]);
  });

  it("hydrates recentViews on the default (published) sort too", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const usage = usageEventsRepository(client);
    const id = await seedListed(client, owner.id);
    await usage.recordView({ canvasId: id, userId: "viewer-a", windowMs: 60_000, now: NOW });
    await usage.recordView({ canvasId: id, userId: "viewer-b", windowMs: 60_000, now: NOW });

    const { items } = await repo.listGallery({
      now: NOW,
      trendingSinceMs: NOW - 1_000,
      limit: 24,
      offset: 0,
    });
    expect(items[0]?.recentViews).toBe(2);
  });
});

describe.each(DIALECTS)("canvasesRepository.listGalleryFacets [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  const NOW = 1_000_000;

  it("returns distinct owners (only those with a visible canvas), id+name+avatar only", async () => {
    client = await makeTestDb(dialect);
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    const carol = await seedUser(client, "carol");
    const repo = canvasesRepository(client);

    await seedListed(client, alice.id);
    await seedListed(client, alice.id); // alice appears once despite two canvases
    await seedListed(client, bob.id);
    // carol has only a non-visible canvas (unlisted) → absent from facets.
    await repo.updateSettings(await seedPublishedCanvas(client, carol.id), { access: "whole_org" });

    const { owners } = await repo.listGalleryFacets(NOW);
    expect(owners.map((o) => o.name)).toEqual(["alice", "bob"]);
    expect(owners.map((o) => o.id).sort()).toEqual([alice.id, bob.id].sort());
    // Exactly the public owner shape — no email / internal flags.
    for (const o of owners) {
      expect(Object.keys(o).sort()).toEqual(["avatarUrl", "id", "name"]);
    }
  });

  it("returns the deduped tag set across visible canvases only", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    await seedListed(client, owner.id, { tags: ["charts", "finance"] });
    await seedListed(client, owner.id, { tags: ["charts", "games"] });
    // A non-visible (unlisted) canvas's tag must NOT leak into the facets.
    await repo.updateSettings(await seedPublishedCanvas(client, owner.id), {
      access: "whole_org",
      tags: ["secret"],
    });

    const { tags } = await repo.listGalleryFacets(NOW);
    expect(tags).toEqual(["charts", "finance", "games"]);
  });
});

describe.each(DIALECTS)("canvasesRepository.findCloneableTemplate [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  const NOW = 1_000_000;

  it("returns the row when listed AND templatable (the non-owner clone gate)", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const id = await seedListed(client, owner.id, { galleryTemplatable: true });
    const repo = canvasesRepository(client);

    const row = await repo.findCloneableTemplate(id, NOW);
    expect(row?.id).toBe(id);
  });

  it("returns null when listed but NOT templatable", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const id = await seedListed(client, owner.id, { galleryTemplatable: false });
    expect(await canvasesRepository(client).findCloneableTemplate(id, NOW)).toBeNull();
  });

  it("returns null for a templatable canvas that is not shared, unpublished, or protected", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);

    // templatable + listed but unshared → predicate (shared=true) excludes it.
    const unshared = await seedListed(client, owner.id, {
      galleryTemplatable: true,
      access: "private",
    });
    expect(await repo.findCloneableTemplate(unshared, NOW)).toBeNull();

    // templatable + listed but password-protected → predicate (password_hash IS NULL) excludes it.
    const protectedId = await seedListed(client, owner.id, { galleryTemplatable: true });
    await repo.setPassword(protectedId, "argon2-hash");
    expect(await repo.findCloneableTemplate(protectedId, NOW)).toBeNull();
  });

  it("returns null for a never-published (undeployed) canvas even if flags were set", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner");
    const repo = canvasesRepository(client);
    const id = await seedUndeployedCanvas(client, owner.id);
    // Force the flags on directly (an undeployed canvas can't be listed via the route).
    await repo.updateSettings(id, {
      access: "whole_org",
      galleryListed: true,
      galleryTemplatable: true,
    });
    expect(await repo.findCloneableTemplate(id, NOW)).toBeNull();
  });
});

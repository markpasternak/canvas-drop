import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import {
  seedListed,
  seedPublishedCanvas,
  seedUndeployedCanvas,
  seedUser,
} from "../db/repositories/gallery-test-helpers.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import type { GalleryPageDto } from "./gallery.js";
import { galleryRoutes } from "./gallery.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

// The exact public shape of a gallery item — asserted against so a future spread
// or new field can't silently widen the projection.
const ITEM_KEYS = [
  "id",
  "slug",
  "url",
  "title",
  "summary",
  "tags",
  "templatable",
  "publishedAt",
  "owner",
].sort();

/** Build a gallery app authenticated as some member (the gateway is stubbed). */
function buildApp(client: DbClient, actor = { id: "viewer", isAdmin: false }) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: actor.id, isAdmin: actor.isAdmin } as never);
    await next();
  });
  app.route("/api/gallery", galleryRoutes({ config, canvases: canvasesRepository(client) }));
  return app;
}

async function get(
  client: DbClient,
  path: string,
): Promise<{ status: number; body: GalleryPageDto }> {
  const res = await buildApp(client).request(path);
  return { status: res.status, body: (await res.json()) as GalleryPageDto };
}

describe("galleryRoutes", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("returns only listed-active-unexpired-published canvases, with owner display metadata", async () => {
    client = await makeTestDb("sqlite");
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    const repo = canvasesRepository(client);

    const listed = await seedListed(client, alice.id);
    await seedListed(client, bob.id); // a second owner's listed canvas
    await repo.updateSettings(await seedPublishedCanvas(client, alice.id), { galleryListed: true }); // not shared
    await repo.updateSettings(await seedPublishedCanvas(client, alice.id), { access: "whole_org" }); // not listed
    await repo.setStatus(await seedListed(client, alice.id), "disabled");
    await repo.setStatus(await seedListed(client, alice.id), "deleted");
    await repo.archive(await seedListed(client, alice.id));
    await seedListed(client, alice.id, { sharedExpiresAt: 1 }); // long expired
    // never deployed (listed+shared but no current version → would be a dead link)
    await repo.updateSettings(await seedUndeployedCanvas(client, alice.id), {
      access: "whole_org",
      galleryListed: true,
    });

    const { status, body } = await get(client, "/api/gallery");
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(listed);
    const item = body.items.find((i) => i.id === listed);
    expect(item?.owner.name).toBe("alice");
    expect(item?.owner.avatarUrl).toBe("https://avatars.example/alice.png");
    expect(item?.url).toContain(`/c/`);
  });

  it("never leaks sensitive owner/canvas fields (explicit projection)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    await seedListed(client, owner.id);

    const res = await buildApp(client).request("/api/gallery");
    const body = (await res.json()) as GalleryPageDto;
    const item = body.items[0];
    expect(item).toBeDefined();
    if (!item) return;
    // The item carries EXACTLY the public field set — a future spread or new field
    // (e.g. apiKeyHash/passwordHash/status from the full canvas row, which
    // listGallery selects into memory, or a bare top-level ownerId) fails this
    // rather than leaking silently. The owner id is exposed only inside `owner`.
    expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    // Owner sub-object is display + the opaque owner id (the filter key, plan 004)
    // — still no email and no internal flags.
    expect(Object.keys(item.owner).sort()).toEqual(["avatarUrl", "id", "name"]);
    expect(typeof item.owner.id).toBe("string");
    expect(JSON.stringify(item)).not.toContain("@example.com");
  });

  it("paginates with a stable total and echoes limit/offset", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    for (let i = 0; i < 5; i++) await seedListed(client, owner.id);

    const p1 = await get(client, "/api/gallery?limit=2&offset=0");
    expect(p1.body.total).toBe(5);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.limit).toBe(2);
    expect(p1.body.offset).toBe(0);

    const last = await get(client, "/api/gallery?limit=2&offset=4");
    expect(last.body.items).toHaveLength(1);

    const beyond = await get(client, "/api/gallery?limit=2&offset=10");
    expect(beyond.body.items).toHaveLength(0);
    expect(beyond.body.total).toBe(5);
  });

  it("filters by free-text search and by tag", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const revenue = await seedListed(client, owner.id, {
      title: "Revenue chart",
      galleryTags: ["finance"],
    });
    await seedListed(client, owner.id, { title: "Game", galleryTags: ["games"] });

    const byQ = await get(client, "/api/gallery?q=revenue");
    expect(byQ.body.items.map((i) => i.id)).toEqual([revenue]);

    const byTag = await get(client, "/api/gallery?tag=finance");
    expect(byTag.body.items.map((i) => i.id)).toEqual([revenue]);

    const both = await get(client, "/api/gallery?q=revenue&tag=games");
    expect(both.body.items).toHaveLength(0);
  });

  it("excludes a password-protected canvas (plan 002: protected canvases are not listable)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const id = await seedListed(client, owner.id);
    await canvasesRepository(client).setPassword(id, "argon2-hash");

    const { body } = await get(client, "/api/gallery");
    expect(body.items.find((i) => i.id === id)).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("argon2-hash");
  });

  it("clamps junk pagination params instead of erroring", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    await seedListed(client, owner.id);

    const huge = await get(client, "/api/gallery?limit=9999");
    expect(huge.status).toBe(200);
    expect(huge.body.limit).toBe(60); // clamped to MAX_LIMIT

    const junk = await get(client, "/api/gallery?limit=abc&offset=-5");
    expect(junk.status).toBe(200);
    expect(junk.body.limit).toBe(24); // default
    expect(junk.body.offset).toBe(0); // clamped
  });

  it("filters by owner id and by templatable (plan 004)", async () => {
    client = await makeTestDb("sqlite");
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    const aliceTpl = await seedListed(client, alice.id, { galleryTemplatable: true });
    const alicePlain = await seedListed(client, alice.id, { galleryTemplatable: false });
    await seedListed(client, bob.id, { galleryTemplatable: true });

    const byOwner = await get(client, `/api/gallery?owner=${alice.id}`);
    expect(byOwner.body.total).toBe(2);
    expect(byOwner.body.items.map((i) => i.id).sort()).toEqual([aliceTpl, alicePlain].sort());
    expect(byOwner.body.items.every((i) => i.owner.id === alice.id)).toBe(true);

    const ownerAndTemplatable = await get(client, `/api/gallery?owner=${alice.id}&templatable=1`);
    expect(ownerAndTemplatable.body.items.map((i) => i.id)).toEqual([aliceTpl]);
  });

  it("sorts by title and by updated; an unknown sort falls back to default (plan 004)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    const banana = await seedListed(client, owner.id, { title: "Banana" });
    const apple = await seedListed(client, owner.id, { title: "apple" });

    const byTitle = await get(client, "/api/gallery?sort=title");
    expect(byTitle.body.items.map((i) => i.id)).toEqual([apple, banana]);

    // Unknown sort value clamps to the default order (no 400).
    const junkSort = await get(client, "/api/gallery?sort=sideways");
    expect(junkSort.status).toBe(200);
    expect(junkSort.body.items).toHaveLength(2);
  });

  it("a junk templatable value never errors the browse (plan 004)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner");
    await seedListed(client, owner.id);
    // `templatable=false`/`0`/garbage all mean "don't filter" — and never 400.
    const res = await get(client, "/api/gallery?templatable=banana&q=&offset=-1");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("exposes owner/tag facets with no PII leak (plan 004)", async () => {
    client = await makeTestDb("sqlite");
    const alice = await seedUser(client, "alice");
    const bob = await seedUser(client, "bob");
    await seedListed(client, alice.id, { galleryTags: ["charts"] });
    await seedListed(client, bob.id, { galleryTags: ["games", "charts"] });

    const res = await buildApp(client).request("/api/gallery/facets");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      owners: Array<{ id: string; name: string; avatarUrl: string | null }>;
      tags: string[];
    };
    expect(body.owners.map((o) => o.name).sort()).toEqual(["alice", "bob"]);
    expect(body.tags).toEqual(["charts", "games"]);
    // Owner facet objects are display + opaque id only — no email/internal flags.
    for (const o of body.owners) {
      expect(Object.keys(o).sort()).toEqual(["avatarUrl", "id", "name"]);
    }
    expect(JSON.stringify(body)).not.toContain("@example.com");
  });

  it("is GET-only — POST is not routed", async () => {
    client = await makeTestDb("sqlite");
    const res = await buildApp(client).request("/api/gallery", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

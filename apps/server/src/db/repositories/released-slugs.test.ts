import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { addCanvasAlias, removeCanvasAlias, renameCanvasSlug } from "../../canvas/slug-aliases.js";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository, SLUG_RESERVATION_MS } from "./canvases.js";
import { usersRepository } from "./users.js";

/**
 * Security regression (audit run-1, #13): in subdomain mode a slug is a browser origin,
 * so a released slug claimed by someone else's canvas inherited what visitors' browsers
 * held for it (storage, service workers, permissions). A released slug is now held for
 * its canvas and owner for {@link SLUG_RESERVATION_MS}.
 */

async function seed(client: DbClient) {
  const users = usersRepository(client);
  const mk = (sub: string) =>
    users.upsert({ providerSub: sub, email: `${sub}@example.com`, name: sub, isAdmin: false });
  const alice = (await mk("alice")).id;
  const bob = (await mk("bob")).id;
  const canvases = canvasesRepository(client);
  const cv = await canvases.create({ ownerId: alice, slug: "launch", apiKeyHash: "h1" });
  const deps = { canvases, audit: { recordAudit: () => {} } };
  return { alice, bob, canvases, cv, deps };
}

async function ageReservation(client: DbClient, slug: string, ms: number) {
  const q = sql`update released_slugs set released_at = released_at - ${ms} where slug = ${slug}`;
  if (client.dialect === "sqlite") client.db.run(q);
  else await client.db.execute(q);
}

describe.each(DIALECTS)("released slug reservation [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("a renamed-away slug is held for its canvas and owner, not for others", async () => {
    client = await makeTestDb(dialect);
    const { alice, bob, canvases, cv, deps } = await seed(client);
    const renamed = await renameCanvasSlug(deps, cv, { slug: "launch-v2" }, alice);
    expect("canvas" in renamed).toBe(true);

    expect(await canvases.slugTaken("launch")).toBe(true); // no claimant: held
    expect(await canvases.slugTaken("launch", { ownerId: bob })).toBe(true);
    expect(await canvases.slugTaken("launch", { ownerId: alice })).toBe(false);
    expect(await canvases.slugTaken("launch", { ownerId: bob, canvasId: cv.id })).toBe(false);

    // Bob can't take it as an alias on his own canvas either.
    const bobs = await canvases.create({ ownerId: bob, slug: "bobs", apiKeyHash: "h2" });
    expect(await addCanvasAlias(deps, bobs, "launch", bob)).toEqual({ error: "slug_taken" });

    // The canvas itself can rename back.
    const current = (await canvases.findById(cv.id)) ?? cv;
    const back = await renameCanvasSlug(deps, current, { slug: "launch" }, alice);
    expect("canvas" in back && back.canvas.slug).toBe("launch");
  });

  it("the reservation lapses after the window", async () => {
    client = await makeTestDb(dialect);
    const { alice, bob, canvases, cv, deps } = await seed(client);
    await renameCanvasSlug(deps, cv, { slug: "launch-v2" }, alice);
    await ageReservation(client, "launch", SLUG_RESERVATION_MS - 60_000);
    expect(await canvases.slugTaken("launch", { ownerId: bob })).toBe(true);
    await ageReservation(client, "launch", 120_000);
    expect(await canvases.slugTaken("launch", { ownerId: bob })).toBe(false);
  });

  it("keeping the old slug as an alias needs no reservation; removing the alias starts one", async () => {
    client = await makeTestDb(dialect);
    const { alice, bob, canvases, cv, deps } = await seed(client);
    await renameCanvasSlug(deps, cv, { slug: "launch-v2", keepOldAsAlias: true }, alice);
    expect(await canvases.slugTaken("launch", { ownerId: alice })).toBe(true); // the alias holds it

    const current = (await canvases.findById(cv.id)) ?? cv;
    await removeCanvasAlias(deps, current, "launch", alice);
    expect(await canvases.slugTaken("launch", { ownerId: bob })).toBe(true);
    expect(await canvases.slugTaken("launch", { ownerId: alice })).toBe(false);
  });

  it("a purge holds the canvas's freed aliases for its owner", async () => {
    client = await makeTestDb(dialect);
    const { alice, bob, canvases, cv, deps } = await seed(client);
    await addCanvasAlias(deps, cv, "launch-old", alice);
    await canvases.finishPurge(cv.id, Date.now());
    expect(await canvases.listAliases(cv.id)).toEqual([]);
    expect(await canvases.slugTaken("launch-old", { ownerId: bob })).toBe(true);
    expect(await canvases.slugTaken("launch-old", { ownerId: alice })).toBe(false);
  });

  it("a released slug claimed again and released again restarts its window for the new holder", async () => {
    client = await makeTestDb(dialect);
    const { alice, bob, canvases, cv, deps } = await seed(client);
    await renameCanvasSlug(deps, cv, { slug: "launch-v2" }, alice);
    await ageReservation(client, "launch", SLUG_RESERVATION_MS + 1000);
    const bobs = await canvases.create({ ownerId: bob, slug: "launch", apiKeyHash: "h3" });
    await renameCanvasSlug(deps, bobs, { slug: "bobs-launch" }, bob);
    expect(await canvases.slugTaken("launch", { ownerId: alice })).toBe(true);
    expect(await canvases.slugTaken("launch", { ownerId: bob })).toBe(false);
  });
});

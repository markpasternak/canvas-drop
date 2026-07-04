import { afterEach, describe, expect, it } from "vitest";
import { dayStartUtc } from "../../ai/quota.js";
import { checkAuthoringQuota } from "../../authoring/quota.js";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { authoringUsageRepository } from "./authoring-usage.js";
import { canvasesRepository } from "./canvases.js";
import { usersRepository } from "./users.js";

/** Seed a viewer + a source canvas + an authored canvas (the three FK targets). */
async function seed(
  client: DbClient,
  sub = "viewer",
): Promise<{ actorId: string; sourceCanvasId: string; authoredCanvasId: string }> {
  const u = await usersRepository(client).upsert({
    providerSub: sub,
    email: `${sub}@example.com`,
    name: sub,
    isAdmin: false,
  });
  const canvases = canvasesRepository(client);
  const src = await canvases.create({
    ownerId: u.id,
    slug: `src-${sub}`,
    apiKeyHash: `h-src-${sub}`,
  });
  const out = await canvases.create({
    ownerId: u.id,
    slug: `out-${sub}`,
    apiKeyHash: `h-out-${sub}`,
  });
  return { actorId: u.id, sourceCanvasId: src.id, authoredCanvasId: out.id };
}

describe.each(DIALECTS)("authoringUsageRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("records an authored canvas and counts it by actor (daily + total)", async () => {
    client = await makeTestDb(dialect);
    const s = await seed(client);
    const repo = authoringUsageRepository(client);
    await repo.record(s);

    expect(await repo.countByActorSince(s.actorId, dayStartUtc(Date.now()))).toBe(1);
    expect(await repo.countByActor(s.actorId)).toBe(1);
  });

  it("the daily window honors `since` (a future cutoff → 0; all-time total unaffected)", async () => {
    client = await makeTestDb(dialect);
    const s = await seed(client);
    const repo = authoringUsageRepository(client);
    await repo.record(s);
    expect(await repo.countByActorSince(s.actorId, Date.now() + 60_000)).toBe(0);
    expect(await repo.countByActor(s.actorId)).toBe(1);
  });

  it("counts are scoped per actor (no cross-leak between viewers)", async () => {
    client = await makeTestDb(dialect);
    const a = await seed(client, "va");
    const b = await seed(client, "vb");
    const repo = authoringUsageRepository(client);
    await repo.record(a);
    await repo.record(a);
    await repo.record(b);

    expect(await repo.countByActor(a.actorId)).toBe(2);
    expect(await repo.countByActor(b.actorId)).toBe(1);
    expect(await repo.countByActor("nobody")).toBe(0);
  });

  it("pruneBefore deletes old rows but leaves the all-time count queryable on newer ones", async () => {
    client = await makeTestDb(dialect);
    const s = await seed(client);
    const repo = authoringUsageRepository(client);
    await repo.record(s);
    expect(await repo.pruneBefore(Date.now() - 1000)).toBe(0);
    expect(await repo.pruneBefore(Date.now() + 60_000)).toBe(1);
    expect(await repo.countByActor(s.actorId)).toBe(0);
  });
});

describe("checkAuthoringQuota", () => {
  const limits = { dailyMax: 3, totalMax: 10 };

  it("allows when both counts are under their limits", () => {
    expect(checkAuthoringQuota(0, 0, limits)).toEqual({ ok: true });
    expect(checkAuthoringQuota(2, 9, limits)).toEqual({ ok: true });
  });

  it("rejects on the daily window at exactly the limit (scope user_daily)", () => {
    expect(checkAuthoringQuota(3, 0, limits)).toEqual({ ok: false, scope: "user_daily" });
  });

  it("rejects on the total window at exactly the limit (scope user_total)", () => {
    expect(checkAuthoringQuota(0, 10, limits)).toEqual({ ok: false, scope: "user_total" });
  });

  it("daily wins when both are exhausted", () => {
    expect(checkAuthoringQuota(3, 10, limits)).toEqual({ ok: false, scope: "user_daily" });
  });
});

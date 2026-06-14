import { afterEach, describe, expect, it } from "vitest";
import { checkQuota } from "../../ai/quota.js";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { aiUsageRepository } from "./ai-usage.js";
import { canvasesRepository } from "./canvases.js";
import { usersRepository } from "./users.js";

async function seed(
  client: DbClient,
  slug = "s",
  sub = "owner",
): Promise<{ canvasId: string; userId: string }> {
  const u = await usersRepository(client).upsert({
    providerSub: sub,
    email: `${sub}@example.com`,
    name: sub,
    isAdmin: false,
  });
  const cv = await canvasesRepository(client).create({
    ownerId: u.id,
    slug,
    apiKeyHash: `h-${slug}`,
  });
  return { canvasId: cv.id, userId: u.id };
}

const rec = (canvasId: string, userId: string, costUsd: number, model = "claude-haiku-4-5") => ({
  canvasId,
  userId,
  provider: "anthropic",
  model,
  inputTokens: 100,
  outputTokens: 50,
  costUsd,
});

describe.each(DIALECTS)("aiUsageRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("records a call and sums user + canvas spend", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = aiUsageRepository(client);
    await repo.record(rec(canvasId, userId, 0.25));
    await repo.record(rec(canvasId, userId, 0.75));

    expect(await repo.userSpendSince(userId, 0)).toBeCloseTo(1.0, 10);
    expect(await repo.canvasSpendSince(canvasId, 0)).toBeCloseTo(1.0, 10);
  });

  it("spend honors the since window (future cutoff → 0)", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = aiUsageRepository(client);
    await repo.record(rec(canvasId, userId, 2.0));
    expect(await repo.userSpendSince(userId, Date.now() + 60_000)).toBe(0);
    expect(await repo.canvasSpendSince(canvasId, Date.now() + 60_000)).toBe(0);
  });

  it("spend is scoped per user and per canvas (no cross-leak)", async () => {
    client = await makeTestDb(dialect);
    const a = await seed(client, "a", "ua");
    const b = await seed(client, "b", "ub");
    const repo = aiUsageRepository(client);
    await repo.record(rec(a.canvasId, a.userId, 1.0));
    await repo.record(rec(b.canvasId, b.userId, 3.0));

    expect(await repo.userSpendSince(a.userId, 0)).toBeCloseTo(1.0, 10);
    expect(await repo.userSpendSince(b.userId, 0)).toBeCloseTo(3.0, 10);
    expect(await repo.canvasSpendSince(a.canvasId, 0)).toBeCloseTo(1.0, 10);
    expect(await repo.canvasSpendSince(b.canvasId, 0)).toBeCloseTo(3.0, 10);
  });

  // Adversarial F7: a real/double SUM seeded to exactly the limit must reject
  // consistently on both dialects (CI runs both legs).
  it("quota boundary: spend summing to exactly the limit rejects on this dialect", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = aiUsageRepository(client);
    await repo.record(rec(canvasId, userId, 1.0));
    await repo.record(rec(canvasId, userId, 2.0));
    await repo.record(rec(canvasId, userId, 2.0)); // total exactly 5.0

    const userSpend = await repo.userSpendSince(userId, 0);
    expect(userSpend).toBeCloseTo(5.0, 9);
    const decision = checkQuota(userSpend, 0, { userDailyUsd: 5, canvasMonthlyUsd: 50 });
    expect(decision).toEqual({ ok: false, scope: "user_daily" });
  });

  it("canvasTotals aggregates tokens, cost, and call count", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = aiUsageRepository(client);
    await repo.record(rec(canvasId, userId, 0.1));
    await repo.record(rec(canvasId, userId, 0.2));

    const totals = await repo.canvasTotals(canvasId);
    expect(totals.calls).toBe(2);
    expect(totals.inputTokens).toBe(200);
    expect(totals.outputTokens).toBe(100);
    expect(totals.costUsd).toBeCloseTo(0.3, 10);
  });

  it("canvasTotals is zeroed for a canvas with no AI calls", async () => {
    client = await makeTestDb(dialect);
    const { canvasId } = await seed(client);
    const repo = aiUsageRepository(client);
    expect(await repo.canvasTotals(canvasId)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      calls: 0,
    });
    expect(await repo.userSpendSince("nobody", 0)).toBe(0);
  });

  it("platformSpend sums cost, tokens, and calls across all canvases/users", async () => {
    client = await makeTestDb(dialect);
    const a = await seed(client, "a", "ua");
    const b = await seed(client, "b", "ub");
    const repo = aiUsageRepository(client);
    await repo.record(rec(a.canvasId, a.userId, 1.0));
    await repo.record(rec(b.canvasId, b.userId, 3.0));

    const total = await repo.platformSpend();
    expect(total.calls).toBe(2);
    expect(total.inputTokens).toBe(200);
    expect(total.outputTokens).toBe(100);
    expect(total.costUsd).toBeCloseTo(4.0, 10);
  });

  it("platformSpend is zeroed (not null) on an empty table", async () => {
    client = await makeTestDb(dialect);
    expect(await aiUsageRepository(client).platformSpend()).toEqual({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
    });
  });

  it("spendByUser groups by user, orders by spend desc, respects the limit", async () => {
    client = await makeTestDb(dialect);
    const a = await seed(client, "a", "ua");
    const b = await seed(client, "b", "ub");
    const repo = aiUsageRepository(client);
    // a spends 1.5 across two calls; b spends 4.0 in one → b ranks first.
    await repo.record(rec(a.canvasId, a.userId, 0.5));
    await repo.record(rec(a.canvasId, a.userId, 1.0));
    await repo.record(rec(b.canvasId, b.userId, 4.0));

    const all = await repo.spendByUser(10);
    expect(all.map((r) => r.id)).toEqual([b.userId, a.userId]);
    expect(all[0].costUsd).toBeCloseTo(4.0, 10);
    expect(all[1].costUsd).toBeCloseTo(1.5, 10);
    expect(all[1].calls).toBe(2);

    const top1 = await repo.spendByUser(1);
    expect(top1).toHaveLength(1);
    expect(top1[0].id).toBe(b.userId);
  });

  it("spendByCanvas groups by canvas, ordered by spend desc, across multiple users", async () => {
    client = await makeTestDb(dialect);
    const a = await seed(client, "a", "ua");
    const b = await seed(client, "b", "ub");
    const repo = aiUsageRepository(client);
    // Two users both spend on canvas a; canvas b gets less → a ranks first.
    await repo.record(rec(a.canvasId, a.userId, 2.0));
    await repo.record(rec(a.canvasId, b.userId, 1.0));
    await repo.record(rec(b.canvasId, b.userId, 0.5));

    const all = await repo.spendByCanvas(10);
    expect(all.map((r) => r.id)).toEqual([a.canvasId, b.canvasId]);
    expect(all[0].costUsd).toBeCloseTo(3.0, 10);
    expect(all[0].calls).toBe(2);
  });

  it("pruneBefore deletes old rows, keeps newer", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, userId } = await seed(client);
    const repo = aiUsageRepository(client);
    await repo.record(rec(canvasId, userId, 1.0));
    // nothing older than now-1s yet
    expect(await repo.pruneBefore(Date.now() - 1000)).toBe(0);
    // everything older than the future cutoff is pruned
    const removed = await repo.pruneBefore(Date.now() + 60_000);
    expect(removed).toBe(1);
    expect(await repo.canvasSpendSince(canvasId, 0)).toBe(0);
  });
});

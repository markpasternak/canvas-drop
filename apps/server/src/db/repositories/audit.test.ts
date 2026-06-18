import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { auditRepository } from "./audit.js";

describe.each(DIALECTS)("auditRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("append persists all fields and recent returns them", async () => {
    client = await makeTestDb(dialect);
    const repo = auditRepository(client);
    await repo.append({
      actorId: "actor-1",
      action: "canvas.publish",
      targetType: "canvas",
      targetId: "canvas-1",
      meta: { from: "draft" },
      ip: "203.0.113.7",
    });
    const rows = await repo.recent();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: "actor-1",
      action: "canvas.publish",
      targetType: "canvas",
      targetId: "canvas-1",
      meta: { from: "draft" },
      ip: "203.0.113.7",
    });
    expect(typeof rows[0]?.createdAt).toBe("number");
  });

  it("append tolerates omitted optional fields (nulls persisted)", async () => {
    client = await makeTestDb(dialect);
    const repo = auditRepository(client);
    await repo.append({ action: "system.boot" });
    const rows = await repo.recent();
    expect(rows[0]).toMatchObject({
      action: "system.boot",
      actorId: null,
      targetType: null,
      targetId: null,
      meta: null,
      ip: null,
    });
  });

  it("recent returns newest-first and respects the limit", async () => {
    client = await makeTestDb(dialect);
    const repo = auditRepository(client);
    for (let i = 0; i < 5; i++) await repo.append({ action: `action.${i}` });

    const all = await repo.recent();
    expect(all).toHaveLength(5);
    // createdAt is non-increasing (newest-first). Same-millisecond ties are
    // allowed, so we assert monotonicity rather than a strict permutation.
    const createdAts = all.map((r) => r.createdAt);
    for (let i = 1; i < createdAts.length; i++) {
      expect(createdAts[i] ?? 0).toBeLessThanOrEqual(createdAts[i - 1] ?? 0);
    }

    const limited = await repo.recent(2);
    expect(limited).toHaveLength(2);
    // The limited window is the two with the largest createdAt.
    const maxCreated = Math.max(...createdAts);
    expect(limited[0]?.createdAt).toBe(maxCreated);
  });

  it("pruneBefore deletes only rows older than the cutoff", async () => {
    client = await makeTestDb(dialect);
    const repo = auditRepository(client);
    await repo.append({ action: "old.event" });
    // Cutoff just ahead of the first append; a second append lands after it.
    const cutoff = Date.now() + 1;
    // Busy-wait a hair so the second row's createdAt is strictly >= cutoff.
    while (Date.now() < cutoff) {
      /* spin to advance the clock past the cutoff */
    }
    await repo.append({ action: "new.event" });

    const removed = await repo.pruneBefore(cutoff);
    expect(removed).toBe(1);
    const rows = await repo.recent();
    expect(rows.map((r) => r.action)).toEqual(["new.event"]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { generateSessionToken, hashToken, sessionsRepository } from "./sessions.js";
import { usersRepository } from "./users.js";

const HOUR = 60 * 60 * 1000;

async function seedUser(client: DbClient): Promise<string> {
  const u = await usersRepository(client).upsert({
    providerSub: "owner",
    email: "owner@example.com",
    name: "Owner",
    isAdmin: false,
  });
  return u.id;
}

describe.each(DIALECTS)("sessionsRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("stores only the token hash, never the raw token", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = sessionsRepository(client);
    const token = generateSessionToken();
    const session = await repo.create({ userId, token, expiresAt: Date.now() + HOUR });
    expect(session.tokenHash).toBe(hashToken(token));
    expect(session.tokenHash).not.toBe(token);
  });

  it("finds a live session by its raw token", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = sessionsRepository(client);
    const token = generateSessionToken();
    await repo.create({ userId, token, expiresAt: Date.now() + HOUR });
    expect((await repo.findLiveByToken(token))?.userId).toBe(userId);
    expect(await repo.findLiveByToken("not-a-real-token")).toBeNull();
  });

  it("excludes revoked sessions", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = sessionsRepository(client);
    const token = generateSessionToken();
    await repo.create({ userId, token, expiresAt: Date.now() + HOUR });
    await repo.revokeByToken(token);
    expect(await repo.findLiveByToken(token)).toBeNull();
  });

  it("excludes expired sessions", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = sessionsRepository(client);
    const token = generateSessionToken();
    await repo.create({ userId, token, expiresAt: Date.now() - 1 });
    expect(await repo.findLiveByToken(token)).toBeNull();
  });

  it("revokeAllForUser drops every live session for the user", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = sessionsRepository(client);
    const t1 = generateSessionToken();
    const t2 = generateSessionToken();
    await repo.create({ userId, token: t1, expiresAt: Date.now() + HOUR });
    await repo.create({ userId, token: t2, expiresAt: Date.now() + HOUR });
    await repo.revokeAllForUser(userId);
    expect(await repo.findLiveByToken(t1)).toBeNull();
    expect(await repo.findLiveByToken(t2)).toBeNull();
  });

  it("rolls the expiry forward with touchExpiry", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = sessionsRepository(client);
    const token = generateSessionToken();
    await repo.create({ userId, token, expiresAt: Date.now() - 1 }); // expired
    expect(await repo.findLiveByToken(token)).toBeNull();
    await repo.touchExpiry(token, Date.now() + HOUR);
    expect(await repo.findLiveByToken(token)).not.toBeNull();
  });

  it("pruneExpiredBefore deletes only sessions that expired before the cutoff", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = sessionsRepository(client);
    const now = Date.now();
    const stale = generateSessionToken();
    const recent = generateSessionToken();
    const live = generateSessionToken();
    await repo.create({ userId, token: stale, expiresAt: now - 2 * HOUR });
    await repo.create({ userId, token: recent, expiresAt: now - 1 });
    await repo.create({ userId, token: live, expiresAt: now + HOUR });

    const removed = await repo.pruneExpiredBefore(now - HOUR);
    expect(removed).toBe(1); // only the 2-hour-stale row
    // The recent (just-expired) and live rows still exist as rows; refresh the
    // recent one's expiry to prove it was not deleted.
    await repo.touchExpiry(recent, now + HOUR);
    expect(await repo.findLiveByToken(recent)).not.toBeNull();
    expect(await repo.findLiveByToken(live)).not.toBeNull();
  });
});

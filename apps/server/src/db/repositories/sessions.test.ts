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
});

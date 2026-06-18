import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { oauthRepository } from "./oauth.js";
import { generateSessionToken, hashToken } from "./sessions.js";
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

function clientInfo(id: string): OAuthClientInformationFull {
  return {
    client_id: id,
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
  } as OAuthClientInformationFull;
}

describe.each(DIALECTS)("oauthRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("round-trips a DCR client registration by id", async () => {
    client = await makeTestDb(dialect);
    const repo = oauthRepository(client);
    expect(await repo.clients.get("missing")).toBeUndefined();
    await repo.clients.upsert(clientInfo("client-a"));
    const got = await repo.clients.get("client-a");
    expect(got?.client_id).toBe("client-a");
    expect(got?.redirect_uris).toEqual(["https://client.example/callback"]);
  });

  it("stores only the code hash, never the raw code", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = oauthRepository(client);
    const code = generateSessionToken();
    await repo.codes.create({
      code,
      clientId: "client-a",
      userId,
      redirectUri: "https://client.example/callback",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      expiresAt: Date.now() + HOUR,
    });
    const live = await repo.codes.findLive(code);
    expect(live?.codeHash).toBe(hashToken(code));
    expect(live?.codeHash).not.toBe(code);
    expect(live?.userId).toBe(userId);
  });

  it("consumes an authorization code exactly once (single-use)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = oauthRepository(client);
    const code = generateSessionToken();
    await repo.codes.create({
      code,
      clientId: "client-a",
      userId,
      redirectUri: "https://client.example/callback",
      codeChallenge: "challenge",
      expiresAt: Date.now() + HOUR,
    });
    const first = await repo.codes.consume(code);
    expect(first?.userId).toBe(userId);
    // Replay: the code is already consumed → no row, no second token grant.
    expect(await repo.codes.consume(code)).toBeNull();
    expect(await repo.codes.findLive(code)).toBeNull();
  });

  it("does not return an expired authorization code", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = oauthRepository(client);
    const code = generateSessionToken();
    await repo.codes.create({
      code,
      clientId: "client-a",
      userId,
      redirectUri: "https://client.example/callback",
      codeChallenge: "challenge",
      expiresAt: Date.now() - 1,
    });
    expect(await repo.codes.findLive(code)).toBeNull();
    expect(await repo.codes.consume(code)).toBeNull();
  });

  it("stores tokens hashed and finds a live access token by raw value", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = oauthRepository(client);
    const token = generateSessionToken();
    await repo.tokens.create({
      token,
      kind: "access",
      clientId: "client-a",
      userId,
      expiresAt: Date.now() + HOUR,
    });
    const live = await repo.tokens.findLive(token, "access");
    expect(live?.userId).toBe(userId);
    expect(live?.tokenHash).toBe(hashToken(token));
    expect(await repo.tokens.findLive("not-a-real-token")).toBeNull();
  });

  it("rejects an expired access token", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = oauthRepository(client);
    const token = generateSessionToken();
    await repo.tokens.create({
      token,
      kind: "access",
      clientId: "client-a",
      userId,
      expiresAt: Date.now() - 1,
    });
    expect(await repo.tokens.findLive(token)).toBeNull();
  });

  it("treats a refresh token with no expiry as live until revoked", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = oauthRepository(client);
    const token = generateSessionToken();
    await repo.tokens.create({ token, kind: "refresh", clientId: "client-a", userId });
    expect(await repo.tokens.findLive(token, "refresh")).not.toBeNull();
    // Kind filter: a refresh token is not findable as an access token.
    expect(await repo.tokens.findLive(token, "access")).toBeNull();
  });

  it("revokes a token (idempotently) so it is no longer live", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = oauthRepository(client);
    const token = generateSessionToken();
    await repo.tokens.create({
      token,
      kind: "access",
      clientId: "client-a",
      userId,
      expiresAt: Date.now() + HOUR,
    });
    await repo.tokens.revoke(token);
    await repo.tokens.revoke(token); // idempotent
    expect(await repo.tokens.findLive(token)).toBeNull();
  });

  it("revokeAllForUser drops every live token for the user", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = oauthRepository(client);
    const access = generateSessionToken();
    const refresh = generateSessionToken();
    await repo.tokens.create({
      token: access,
      kind: "access",
      clientId: "client-a",
      userId,
      expiresAt: Date.now() + HOUR,
    });
    await repo.tokens.create({ token: refresh, kind: "refresh", clientId: "client-a", userId });
    await repo.tokens.revokeAllForUser(userId);
    expect(await repo.tokens.findLive(access)).toBeNull();
    expect(await repo.tokens.findLive(refresh, "refresh")).toBeNull();
  });

  it("codes.pruneConsumedOrExpiredBefore removes only spent codes past the cutoff", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = oauthRepository(client);
    const now = Date.now();
    const base = {
      clientId: "client-a",
      userId,
      redirectUri: "https://client.example/callback",
      codeChallenge: "challenge",
    };
    const expiredStale = generateSessionToken();
    const liveCode = generateSessionToken();
    const consumedStale = generateSessionToken();
    await repo.codes.create({ ...base, code: expiredStale, expiresAt: now - 2 * HOUR });
    await repo.codes.create({ ...base, code: liveCode, expiresAt: now + HOUR });
    await repo.codes.create({ ...base, code: consumedStale, expiresAt: now + HOUR });
    // Consume one well before the cutoff so its consumedAt predates it.
    await repo.codes.consume(consumedStale, now - 2 * HOUR);

    const removed = await repo.codes.pruneConsumedOrExpiredBefore(now - HOUR);
    expect(removed).toBe(2); // expired-stale + consumed-stale
    expect(await repo.codes.findLive(liveCode, now)).not.toBeNull(); // live code untouched
  });

  it("tokens.pruneRevokedOrExpiredBefore removes only dead tokens past the cutoff", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client);
    const repo = oauthRepository(client);
    const now = Date.now();
    const expiredStale = generateSessionToken();
    const liveAccess = generateSessionToken();
    const revokedStale = generateSessionToken();
    const liveRefresh = generateSessionToken();
    await repo.tokens.create({
      token: expiredStale,
      kind: "access",
      clientId: "client-a",
      userId,
      expiresAt: now - 2 * HOUR,
    });
    await repo.tokens.create({
      token: liveAccess,
      kind: "access",
      clientId: "client-a",
      userId,
      expiresAt: now + HOUR,
    });
    await repo.tokens.create({
      token: revokedStale,
      kind: "refresh",
      clientId: "client-a",
      userId,
    });
    await repo.tokens.consume(revokedStale, "refresh", now - 2 * HOUR); // revoked well before cutoff
    await repo.tokens.create({ token: liveRefresh, kind: "refresh", clientId: "client-a", userId });

    const removed = await repo.tokens.pruneRevokedOrExpiredBefore(now - HOUR);
    expect(removed).toBe(2); // expired-stale access + revoked-stale refresh
    expect(await repo.tokens.findLive(liveAccess, "access", now)).not.toBeNull();
    expect(await repo.tokens.findLive(liveRefresh, "refresh", now)).not.toBeNull();
  });
});

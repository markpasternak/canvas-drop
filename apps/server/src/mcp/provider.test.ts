import { type Config, loadConfig } from "@canvas-drop/shared";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Context } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedIdentity } from "../auth/strategy.js";
import type { DbClient } from "../db/factory.js";
import { oauthRepository } from "../db/repositories/oauth.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { McpOAuthProvider } from "./provider.js";

const CLIENT: OAuthClientInformationFull = {
  client_id: "client-a",
  redirect_uris: ["https://client.example/callback"],
  token_endpoint_auth_method: "none",
} as OAuthClientInformationFull;

const PARAMS: AuthorizationParams = {
  redirectUri: "https://client.example/callback",
  codeChallenge: "the-challenge",
  state: "xyz",
  scopes: [],
};

/** Minimal Context double exercising exactly what `authorize` touches. The host
 *  matches the default config base URL so the returnTo survives open-redirect checks. */
function fakeCtx(url = "http://localhost:3000/authorize?client_id=client-a"): Context<AppEnv> {
  let res: Response | undefined;
  return {
    get: (k: string) => (k === "clientIp" ? "127.0.0.1" : undefined),
    req: {
      header: (h: string) => (h.toLowerCase() === "host" ? "localhost:3000" : undefined),
      url,
    },
    redirect: (to: string) => new Response(null, { status: 302, headers: { location: to } }),
    get res() {
      return res;
    },
    set res(r: Response | undefined) {
      res = r;
    },
  } as unknown as Context<AppEnv>;
}

function codeFrom(res: Response | undefined): string {
  const loc = res?.headers.get("location");
  if (!loc) throw new Error("no redirect location");
  return new URL(loc).searchParams.get("code") ?? "";
}

function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error("expected a value");
  return v;
}

interface Harness {
  provider: McpOAuthProvider;
  oauth: ReturnType<typeof oauthRepository>;
  users: ReturnType<typeof usersRepository>;
  setIdentity: (id: ResolvedIdentity | null) => void;
}

function harness(client: DbClient, config: Config): Harness {
  let identity: ResolvedIdentity | null = null;
  const oauth = oauthRepository(client);
  const users = usersRepository(client);
  const provider = new McpOAuthProvider({
    config,
    strategy: { resolveIdentity: async () => identity },
    users,
    allowedEmails: { isAllowed: async () => false },
    oauth,
  });
  return { provider, oauth, users, setIdentity: (id) => (identity = id) };
}

const devConfig = () => loadConfig({ CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com" });
const oidcConfig = (): Config => {
  const base = devConfig();
  return { ...base, auth: { ...base.auth, mode: "oidc" } } as Config;
};

describe.each(DIALECTS)("McpOAuthProvider [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("redirects an unauthenticated authorize to the existing login (oidc), issuing no code", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, oidcConfig());
    h.setIdentity(null);
    const c = fakeCtx();
    await h.provider.authorize(CLIENT, PARAMS, c);
    const loc = c.res?.headers.get("location") ?? "";
    expect(loc).toContain("/auth/login");
    expect(loc).toContain("returnTo=");
    // No session ⇒ no authorization code minted.
    expect(loc).not.toContain("code=");
  });

  it("denies an unauthenticated authorize in non-oidc modes (no login to bounce to)", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity(null);
    await expect(h.provider.authorize(CLIENT, PARAMS, fakeCtx())).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("denies a caller whose email domain is not allowed", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity({ sub: "oidc:evil", email: "intruder@evil.com", name: "X" });
    await expect(h.provider.authorize(CLIENT, PARAMS, fakeCtx())).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("denies a blocked user even though the upsert never resets the block", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity({ sub: "oidc:owner", email: "owner@example.com", name: "Owner" });
    // First authorize creates the user; then block them and retry.
    await h.provider.authorize(CLIENT, PARAMS, fakeCtx());
    const user = await h.users.findByEmail("owner@example.com");
    await h.users.setBlocked(must(user).id, true);
    await expect(h.provider.authorize(CLIENT, PARAMS, fakeCtx())).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("issues a single-use code bound to the strategy-resolved user (never the client)", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity({ sub: "oidc:owner", email: "owner@example.com", name: "Owner" });
    const c = fakeCtx();
    await h.provider.authorize(CLIENT, PARAMS, c);
    const loc = c.res?.headers.get("location") ?? "";
    expect(loc.startsWith("https://client.example/callback")).toBe(true);
    expect(new URL(loc).searchParams.get("state")).toBe("xyz");
    const code = codeFrom(c.res);
    const stored = await h.oauth.codes.findLive(code);
    const user = await h.users.findByEmail("owner@example.com");
    expect(stored?.userId).toBe(must(user).id);
    expect(stored?.codeChallenge).toBe("the-challenge");
  });

  it("exchanges a code once, then rejects replay (single-use) and verifies the token", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity({ sub: "oidc:owner", email: "owner@example.com", name: "Owner" });
    const c = fakeCtx();
    await h.provider.authorize(CLIENT, PARAMS, c);
    const code = codeFrom(c.res);

    // The token handler verifies PKCE against this before exchanging.
    expect(await h.provider.challengeForAuthorizationCode(CLIENT, code)).toBe("the-challenge");

    const tokens = await h.provider.exchangeAuthorizationCode(
      CLIENT,
      code,
      undefined,
      "https://client.example/callback",
    );
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const user = await h.users.findByEmail("owner@example.com");
    const info = await h.provider.verifyAccessToken(tokens.access_token);
    expect(info.extra?.userId).toBe(must(user).id);

    // Replay of the same code is refused.
    await expect(
      h.provider.exchangeAuthorizationCode(
        CLIENT,
        code,
        undefined,
        "https://client.example/callback",
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects an authorization code presented by a different client", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity({ sub: "oidc:owner", email: "owner@example.com", name: "Owner" });
    const c = fakeCtx();
    await h.provider.authorize(CLIENT, PARAMS, c);
    const code = codeFrom(c.res);
    const other = { ...CLIENT, client_id: "client-b" } as OAuthClientInformationFull;
    await expect(
      h.provider.exchangeAuthorizationCode(
        other,
        code,
        undefined,
        "https://client.example/callback",
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects an authorization code with a mismatched redirect_uri", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity({ sub: "oidc:owner", email: "owner@example.com", name: "Owner" });
    const c = fakeCtx();
    await h.provider.authorize(CLIENT, PARAMS, c);
    const code = codeFrom(c.res);
    await expect(
      h.provider.exchangeAuthorizationCode(
        CLIENT,
        code,
        undefined,
        "https://evil.example/callback",
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects an unknown access token and a revoked one", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity({ sub: "oidc:owner", email: "owner@example.com", name: "Owner" });
    await expect(h.provider.verifyAccessToken("not-a-token")).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    const c = fakeCtx();
    await h.provider.authorize(CLIENT, PARAMS, c);
    const tokens = await h.provider.exchangeAuthorizationCode(
      CLIENT,
      codeFrom(c.res),
      undefined,
      "https://client.example/callback",
    );
    await h.provider.revokeToken(CLIENT, { token: tokens.access_token });
    await expect(h.provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it("rotates the refresh token: the presented refresh token is single-use", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity({ sub: "oidc:owner", email: "owner@example.com", name: "Owner" });
    const c = fakeCtx();
    await h.provider.authorize(CLIENT, PARAMS, c);
    const tokens = await h.provider.exchangeAuthorizationCode(
      CLIENT,
      codeFrom(c.res),
      undefined,
      "https://client.example/callback",
    );
    const rotated = await h.provider.exchangeRefreshToken(CLIENT, must(tokens.refresh_token));
    expect(rotated.access_token).toBeTruthy();
    // The old refresh token no longer works.
    await expect(
      h.provider.exchangeRefreshToken(CLIENT, must(tokens.refresh_token)),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rotates refresh atomically: concurrent reuse yields exactly one new pair", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity({ sub: "oidc:owner", email: "owner@example.com", name: "Owner" });
    const c = fakeCtx();
    await h.provider.authorize(CLIENT, PARAMS, c);
    const tokens = await h.provider.exchangeAuthorizationCode(
      CLIENT,
      codeFrom(c.res),
      undefined,
      "https://client.example/callback",
    );
    const refresh = must(tokens.refresh_token);
    const results = await Promise.allSettled([
      h.provider.exchangeRefreshToken(CLIENT, refresh),
      h.provider.exchangeRefreshToken(CLIENT, refresh),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("rejects a live access token AND refresh once the user is blocked (lifecycle honored)", async () => {
    client = await makeTestDb(dialect);
    const h = harness(client, devConfig());
    h.setIdentity({ sub: "oidc:owner", email: "owner@example.com", name: "Owner" });
    const c = fakeCtx();
    await h.provider.authorize(CLIENT, PARAMS, c);
    const tokens = await h.provider.exchangeAuthorizationCode(
      CLIENT,
      codeFrom(c.res),
      undefined,
      "https://client.example/callback",
    );
    // The token works while the user is active.
    expect((await h.provider.verifyAccessToken(tokens.access_token)).extra?.userId).toBeTruthy();
    // Block the user — the live token and its refresh chain must both die at once.
    const user = await h.users.findByEmail("owner@example.com");
    await h.users.setBlocked(must(user).id, true);
    await expect(h.provider.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    await expect(
      h.provider.exchangeRefreshToken(CLIENT, must(tokens.refresh_token)),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects a live access token once the user's email is no longer allowed", async () => {
    client = await makeTestDb(dialect);
    // Issue under a config where example.com is allowed…
    const issue = harness(client, devConfig());
    issue.setIdentity({ sub: "oidc:owner", email: "owner@example.com", name: "Owner" });
    const c = fakeCtx();
    await issue.provider.authorize(CLIENT, PARAMS, c);
    const tokens = await issue.provider.exchangeAuthorizationCode(
      CLIENT,
      codeFrom(c.res),
      undefined,
      "https://client.example/callback",
    );
    // …then verify under a provider whose allowlist no longer covers the domain.
    const deny = new McpOAuthProvider({
      config: loadConfig({ CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "other.com" }),
      strategy: { resolveIdentity: async () => null },
      users: issue.users,
      allowedEmails: { isAllowed: async () => false },
      oauth: issue.oauth,
    });
    await expect(deny.verifyAccessToken(tokens.access_token)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });
});

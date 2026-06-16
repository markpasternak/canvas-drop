import { type Config, loadConfig } from "@canvas-drop/shared";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Context } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
import { devStrategy } from "../auth/dev.js";
import { sessionService } from "../auth/session.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { oauthRepository } from "../db/repositories/oauth.js";
import { generateSessionToken, sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { type McpAuditSink, McpOAuthProvider } from "./provider.js";

const silent = pino({ level: "silent" });
const HOUR = 60 * 60 * 1000;

const CLIENT = {
  client_id: "client-a",
  redirect_uris: ["https://client.example/callback"],
  token_endpoint_auth_method: "none",
} as OAuthClientInformationFull;
const PARAMS: AuthorizationParams = {
  redirectUri: "https://client.example/callback",
  codeChallenge: "ch",
  scopes: [],
};

function fakeCtx(): Context<AppEnv> {
  let res: Response | undefined;
  return {
    get: () => "127.0.0.1",
    req: { header: () => "localhost:3000", url: "http://localhost:3000/authorize" },
    redirect: (to: string) => new Response(null, { status: 302, headers: { location: to } }),
    get res() {
      return res;
    },
    set res(r: Response | undefined) {
      res = r;
    },
  } as unknown as Context<AppEnv>;
}

describe("MCP OAuth lifecycle audit", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("records authorize, token-issue, and token-revoke audit events", async () => {
    client = await makeTestDb("sqlite");
    const config = loadConfig({ CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com" });
    const oauth = oauthRepository(client);
    const events: string[] = [];
    const audit: McpAuditSink = { record: (e) => events.push(e.action) };
    const provider = new McpOAuthProvider({
      config,
      strategy: { resolveIdentity: async () => ({ sub: "s", email: "o@example.com", name: "O" }) },
      users: usersRepository(client),
      allowedEmails: { isAllowed: async () => false },
      oauth,
      audit,
    });

    const c = fakeCtx();
    await provider.authorize(CLIENT, PARAMS, c);
    const loc = c.res?.headers.get("location");
    if (!loc) throw new Error("no redirect");
    const code = new URL(loc).searchParams.get("code") ?? "";
    const tokens = await provider.exchangeAuthorizationCode(
      CLIENT,
      code,
      undefined,
      "https://client.example/callback",
    );
    await provider.revokeToken(CLIENT, { token: tokens.access_token });

    expect(events).toContain("mcp_authorize_ok");
    expect(events).toContain("mcp_token_issue");
    expect(events).toContain("mcp_token_revoke");
  });
});

function appWith(client: DbClient, config: Config) {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  return buildApp({
    config,
    db: client,
    rootLogger: silent,
    strategy: devStrategy(config),
    users: usersRepository(client),
    canvases,
    versions,
    drafts,
    storage,
    engine: deployEngine({ config, canvases, versions, drafts, storage, log: silent }),
    audit: createAuditLog(auditRepository(client), silent),
    sessionSvc: sessionService(config, sessionsRepository(client)),
    peerIp: () => "127.0.0.1",
  });
}

describe("MCP per-caller rate limit", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("throttles tool calls past the per-minute limit (429)", async () => {
    client = await makeTestDb("sqlite");
    const config = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_ADMIN_EMAILS: "a@example.com",
      CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN: "1",
    });
    const a = appWith(client, config);

    // Seed a user + a live access token directly (bypass the full OAuth dance).
    const user = await usersRepository(client).upsert({
      providerSub: "owner",
      email: "owner@example.com",
      name: "Owner",
      isAdmin: false,
    });
    const token = generateSessionToken();
    await oauthRepository(client).tokens.create({
      token,
      kind: "access",
      clientId: "client-a",
      userId: user.id,
      expiresAt: Date.now() + HOUR,
    });

    const call = () =>
      a.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

    const first = await call();
    expect(first.status).not.toBe(429);
    const second = await call();
    expect(second.status).toBe(429);
  });

  it("returns the transport's protocol error (not an opaque 500) for a malformed authed call", async () => {
    client = await makeTestDb("sqlite");
    const config = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_ADMIN_EMAILS: "a@example.com",
    });
    const a = appWith(client, config);
    const user = await usersRepository(client).upsert({
      providerSub: "owner",
      email: "owner@example.com",
      name: "Owner",
      isAdmin: false,
    });
    const token = generateSessionToken();
    await oauthRepository(client).tokens.create({
      token,
      kind: "access",
      clientId: "client-a",
      userId: user.id,
      expiresAt: Date.now() + HOUR,
    });
    // Authenticated, but a body the JSON-RPC transport rejects: must surface a 4xx
    // protocol error, never the app-level 500 that onError would otherwise produce.
    const res = await a.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "}{ not valid json",
    });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

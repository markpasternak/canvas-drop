import { createHash, randomBytes } from "node:crypto";
import { loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
import { SESSION_COOKIE, sessionBackedStrategy, sessionService } from "../auth/session.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";

/**
 * Security regressions (audit run-1, tier A): the MCP OAuth authorization server must
 * not hand a signed-in member's delegation to a client the member never approved, and
 * its unauthenticated endpoints must actually be rate limited.
 */

const silent = pino({ level: "silent" });
const BASE = "https://canvases.example.com";
const APEX = "canvases.example.com";
const CLIENT_CALLBACK = "https://client.example.net/callback";

const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: BASE,
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_OIDC_ISSUER: "https://idp.example.com",
  CANVAS_DROP_OIDC_CLIENT_ID: "id",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
});

async function setup(client: DbClient) {
  const users = usersRepository(client);
  const member = await users.upsert({
    providerSub: "oidc:member",
    email: "member@example.com",
    name: "member",
    isAdmin: false,
  });
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  const sessionSvc = sessionService(config, sessionsRepository(client));
  const app = buildApp({
    config,
    db: client,
    rootLogger: silent,
    strategy: sessionBackedStrategy(sessionSvc, users),
    sessionSvc,
    users,
    canvases,
    versions,
    drafts,
    storage,
    engine: deployEngine({ config, canvases, versions, drafts, storage, log: silent }),
    audit: createAuditLog(auditRepository(client), silent),
    peerIp: () => "8.8.8.8",
  });

  const issuer = new Hono<AppEnv>();
  issuer.get("/:uid", async (c) => {
    await sessionSvc.issue(c, c.req.param("uid"));
    return c.text("ok");
  });
  const res = await issuer.request(`/${member.id}`);
  let cookie = "";
  for (const sc of res.headers.getSetCookie()) {
    const m = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(sc);
    if (m) cookie = `${SESSION_COOKIE}=${decodeURIComponent(m[1] ?? "")}`;
  }
  return { app, cookie };
}

/** Anonymous Dynamic Client Registration of a public client with its own callback. */
async function register(app: Hono<AppEnv>) {
  return app.request(`${BASE}/register`, {
    method: "POST",
    headers: { host: APEX, "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Some Agent",
      redirect_uris: [CLIENT_CALLBACK],
      token_endpoint_auth_method: "none",
      scope: "canvas-drop",
    }),
  });
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe.each(DIALECTS)("MCP OAuth authorize consent [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("a signed-in member following a client's /authorize link does not silently delegate to it", async () => {
    client = await makeTestDb(dialect);
    const { app, cookie } = await setup(client);
    const reg = await register(app);
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const qs = new URLSearchParams({
      client_id,
      redirect_uri: CLIENT_CALLBACK,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "canvas-drop",
      state: "s1",
    });

    // The member's browser navigates top-level from a link on another site.
    const res = await app.request(`${BASE}/authorize?${qs}`, {
      headers: {
        host: APEX,
        cookie,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    const location = res.headers.get("location") ?? "";
    const code = location.startsWith(CLIENT_CALLBACK)
      ? new URL(location).searchParams.get("code")
      : null;

    let detail = "no code issued";
    if (code) {
      // Record what the unapproved client can do with it, for the failure message.
      const token = await app.request(`${BASE}/token`, {
        method: "POST",
        headers: { host: APEX, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id,
          redirect_uri: CLIENT_CALLBACK,
        }),
      });
      const body = (await token.json()) as { access_token?: string; refresh_token?: string };
      detail = `token exchange ${token.status}, access_token=${!!body.access_token}, refresh_token=${!!body.refresh_token}`;
    }
    expect(code, `authorize answered ${res.status}; ${detail}`).toBeNull();
    // Instead the member sees an unframeable consent page naming the client.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Some Agent");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("approving on the consent page issues a code, and the approval is remembered", async () => {
    client = await makeTestDb(dialect);
    const { app, cookie } = await setup(client);
    const { client_id } = (await (await register(app)).json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const params = authorizeParams(client_id, challenge);

    const consent = await app.request(`${BASE}/authorize/consent`, {
      method: "POST",
      headers: {
        host: APEX,
        cookie,
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ ...Object.fromEntries(params), decision: "allow" }),
    });
    expect(consent.status).toBe(303);
    const back = new URL(consent.headers.get("location") ?? "", BASE);
    expect(back.pathname).toBe("/authorize");

    const res = await app.request(`${BASE}${back.pathname}${back.search}`, {
      headers: { host: APEX, cookie, "sec-fetch-site": "same-origin" },
    });
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(CLIENT_CALLBACK), `authorize ${res.status} -> ${location}`).toBe(
      true,
    );
    const code = new URL(location).searchParams.get("code");
    expect(code).toBeTruthy();
    const token = await app.request(`${BASE}/token`, {
      method: "POST",
      headers: { host: APEX, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code as string,
        code_verifier: verifier,
        client_id,
        redirect_uri: CLIENT_CALLBACK,
      }),
    });
    expect(token.status).toBe(200);

    // A later authorization for the same client (re-auth) skips the consent page.
    const again = pkce();
    const reauth = await app.request(
      `${BASE}/authorize?${authorizeParams(client_id, again.challenge)}`,
      { headers: { host: APEX, cookie, "sec-fetch-site": "cross-site" } },
    );
    expect(reauth.headers.get("location") ?? "").toContain("code=");
  });

  it("the consent POST refuses cross-site submissions and honours Cancel", async () => {
    client = await makeTestDb(dialect);
    const { app, cookie } = await setup(client);
    const { client_id } = (await (await register(app)).json()) as { client_id: string };
    const params = Object.fromEntries(authorizeParams(client_id, pkce().challenge));
    const post = (site: string, decision: string) =>
      app.request(`${BASE}/authorize/consent`, {
        method: "POST",
        headers: {
          host: APEX,
          cookie,
          "sec-fetch-site": site,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ ...params, decision }),
      });
    expect((await post("cross-site", "allow")).status).toBe(403);
    expect((await post("same-site", "allow")).status).toBe(403);
    const cancel = await post("same-origin", "deny");
    expect(cancel.status).toBe(303);
    expect(cancel.headers.get("location")).toContain("error=access_denied");
    expect(cancel.headers.get("location")).not.toContain("code=");
  });

  it("a forged or mismatched consent token does not issue a code", async () => {
    client = await makeTestDb(dialect);
    const { app, cookie } = await setup(client);
    const { client_id } = (await (await register(app)).json()) as { client_id: string };
    const params = authorizeParams(client_id, pkce().challenge);
    params.set("consent", `${Date.now() + 60_000}.${"0".repeat(64)}`);
    const res = await app.request(`${BASE}/authorize?${params}`, {
      headers: { host: APEX, cookie },
    });
    expect(res.headers.get("location") ?? "").not.toContain("code=");
  });

  it("unauthenticated client registration is rate limited per client IP", async () => {
    client = await makeTestDb(dialect);
    const { app } = await setup(client);
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) statuses.push((await register(app)).status);
    expect(
      statuses.filter((s) => s === 201).length,
      `statuses: ${statuses.join(",")}`,
    ).toBeLessThanOrEqual(30);
    expect(statuses).toContain(429);
  });
});

function authorizeParams(clientId: string, challenge: string) {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: CLIENT_CALLBACK,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "canvas-drop",
    state: "s1",
  });
}

import { loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
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
import {
  ACCOUNTS_COOKIE,
  SESSION_COOKIE,
  sessionBackedStrategy,
  sessionService,
} from "./session.js";

const silent = pino({ level: "silent" });
const BASE = "https://canvases.example.com";
const APEX = "canvases.example.com";
const CANVAS_HOST = "secret.canvases.example.com";
const CANVAS_URL = `https://${CANVAS_HOST}/`;

const oidcConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: BASE,
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_OIDC_ISSUER: "https://idp.example.com",
  CANVAS_DROP_OIDC_CLIENT_ID: "id",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
});

async function* folder(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    yield { path, bytes: new TextEncoder().encode(content) };
  }
}

/**
 * Multi-account sign-in end to end (oidc, subdomain): a browser holding two accounts,
 * where only `owner` may open the private canvas and `other` is active.
 */
async function setup(client: DbClient) {
  const users = usersRepository(client);
  const sessions = sessionsRepository(client);
  const owner = await users.upsert({
    providerSub: "oidc:owner",
    email: "owner@example.com",
    name: "Owner",
    isAdmin: false,
  });
  const other = await users.upsert({
    providerSub: "oidc:other",
    email: "other@example.com",
    name: "Other",
    isAdmin: false,
  });
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  const engine = deployEngine({
    config: oidcConfig,
    canvases,
    versions,
    drafts,
    storage,
    log: silent,
  });
  const cv = await canvases.create({ ownerId: owner.id, slug: "secret", apiKeyHash: "h" });
  await engine.deploy(cv, "api", folder({ "index.html": "<h1>owner only</h1>" }), owner.id);
  await canvases.setAccess(cv.id, "private");

  const sessionSvc = sessionService(oidcConfig, sessions);
  const app = buildApp({
    config: oidcConfig,
    db: client,
    rootLogger: silent,
    strategy: sessionBackedStrategy(sessionSvc, users),
    sessionSvc,
    users,
    canvases,
    versions,
    drafts,
    storage,
    engine,
    audit: createAuditLog(auditRepository(client), silent),
    peerIp: () => "8.8.8.8",
  });

  // Sign in as owner, then as other, through the real session service so the jar
  // cookie carries its genuine MAC (bound to other's active session).
  const issuer = new Hono<AppEnv>();
  issuer.get("/:uid", async (c) => {
    await sessionSvc.issue(c, c.req.param("uid"));
    return c.text("ok");
  });
  const first = await issuer.request(`/${owner.id}`);
  const ownerToken = setCookieValue(first, SESSION_COOKIE) as string;
  const second = await issuer.request(`/${other.id}`, {
    headers: { cookie: `${SESSION_COOKIE}=${ownerToken}` },
  });
  const otherToken = setCookieValue(second, SESSION_COOKIE) as string;
  const jar = setCookieValue(second, ACCOUNTS_COOKIE) as string;
  /** Cookie header: `other` active, `owner` kept in the account jar. */
  const both = `${SESSION_COOKIE}=${otherToken}; ${ACCOUNTS_COOKIE}=${jar}`;
  return { app, users, owner, other, ownerToken, otherToken, both };
}

function setCookieValue(res: Response, name: string): string | undefined {
  for (const sc of res.headers.getSetCookie()) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(sc);
    if (m) return decodeURIComponent(m[1] ?? "");
  }
  return undefined;
}

function switchForm(account: string, returnTo?: string) {
  const body = new URLSearchParams({ account });
  if (returnTo) body.set("returnTo", returnTo);
  return body;
}

describe.each(DIALECTS)("multi-account sign-in [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("a canvas 404 offers 'Continue as' the held account that can open it", async () => {
    client = await makeTestDb(dialect);
    const { app, owner, both } = await setup(client);
    const res = await app.request("/", {
      headers: { host: CANVAS_HOST, accept: "text/html", cookie: both },
    });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Continue as owner@example.com");
    expect(html).toContain(`account=${owner.id}`);
    expect(html).not.toContain("owner only");
  });

  it("keeps the JSON 404 byte-identical (the probe only feeds the HTML page)", async () => {
    client = await makeTestDb(dialect);
    const { app, both } = await setup(client);
    const res = await app.request("/", {
      headers: { host: CANVAS_HOST, accept: "application/json", cookie: both },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify({ error: "not_found" }));
  });

  it("with no account that has access, a denied and a missing canvas render the same page", async () => {
    client = await makeTestDb(dialect);
    const { app, otherToken } = await setup(client);
    const cookie = `${SESSION_COOKIE}=${otherToken}`;
    const page = async (host: string) => {
      const html = await (
        await app.request("/", { headers: { host, accept: "text/html", cookie } })
      ).text();
      return html.replaceAll(host, "HOST").replaceAll(encodeURIComponent(host), "HOST");
    };
    const denied = await page(CANVAS_HOST);
    expect(denied).toContain("Use another account");
    expect(denied).not.toContain("Continue as");
    expect(await page("nope.canvases.example.com")).toBe(denied);
  });

  it("does not offer a blocked held account", async () => {
    client = await makeTestDb(dialect);
    const { app, users, owner, both } = await setup(client);
    await users.setBlocked(owner.id, true);
    const html = await (
      await app.request("/", { headers: { host: CANVAS_HOST, accept: "text/html", cookie: both } })
    ).text();
    expect(html).not.toContain("Continue as");
    const list = await app.request("/api/me/accounts", { headers: { host: APEX, cookie: both } });
    expect(await list.json()).toEqual({ accounts: [] });
  });

  it("lists the other accounts as explicit summaries at /api/me/accounts", async () => {
    client = await makeTestDb(dialect);
    const { app, owner, both } = await setup(client);
    const res = await app.request("/api/me/accounts", { headers: { host: APEX, cookie: both } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accounts: [{ id: owner.id, email: "owner@example.com", name: "Owner", avatarUrl: null }],
    });
  });

  it("renders the account chooser with a same-origin switch form carrying returnTo", async () => {
    client = await makeTestDb(dialect);
    const { app, owner, both } = await setup(client);
    const res = await app.request(
      `/auth/accounts?returnTo=${encodeURIComponent(CANVAS_URL)}&account=${owner.id}`,
      { headers: { host: APEX, cookie: both } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('action="/auth/switch"');
    expect(html).toContain(`value="${owner.id}"`);
    expect(html).toContain(`value="${CANVAS_URL}"`);
    expect(html).toContain("Continue as owner@example.com?");
    expect(html).toContain("other@example.com"); // the current account, marked Current
    // A canvas is same-site with the instance, so it must not be able to frame this.
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("sends a browser with no session from the chooser to sign-in", async () => {
    client = await makeTestDb(dialect);
    const { app } = await setup(client);
    const res = await app.request("/auth/accounts", { headers: { host: APEX } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });

  it("switches on a same-origin POST and lands back on the canvas, which now opens", async () => {
    client = await makeTestDb(dialect);
    const { app, owner, ownerToken, otherToken, both } = await setup(client);
    const res = await app.request("/auth/switch", {
      method: "POST",
      headers: { host: APEX, cookie: both, "sec-fetch-site": "same-origin" },
      body: switchForm(owner.id, CANVAS_URL),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(CANVAS_URL);
    expect(setCookieValue(res, SESSION_COOKIE)).toBe(ownerToken);
    const jar = setCookieValue(res, ACCOUNTS_COOKIE) as string;
    expect(jar.split(".").slice(1)).toEqual([otherToken]);

    const canvas = await app.request("/", {
      headers: {
        host: CANVAS_HOST,
        accept: "text/html",
        cookie: `${SESSION_COOKIE}=${ownerToken}; ${ACCOUNTS_COOKIE}=${jar}`,
      },
    });
    expect(canvas.status).toBe(200);
    expect(await canvas.text()).toContain("owner only");
  });

  it("refuses a cross-origin switch (a canvas can't flip the visitor's account)", async () => {
    client = await makeTestDb(dialect);
    const { app, owner, both } = await setup(client);
    for (const site of ["same-site", "cross-site"]) {
      const res = await app.request("/auth/switch", {
        method: "POST",
        headers: { host: APEX, cookie: both, "sec-fetch-site": site },
        body: switchForm(owner.id),
      });
      expect(res.status).toBe(403);
      expect(setCookieValue(res, SESSION_COOKIE)).toBeUndefined();
    }
  });

  it("refuses a switch or sign-out from a canvas page's own origin (subdomain mode)", async () => {
    client = await makeTestDb(dialect);
    const { app, owner, both } = await setup(client);
    // `/auth` answers on canvas hosts, where the canvas's own fetch is same-origin.
    const switched = await app.request("/auth/switch", {
      method: "POST",
      headers: { host: CANVAS_HOST, cookie: both, "sec-fetch-site": "same-origin" },
      body: switchForm(owner.id),
    });
    expect(switched.status).toBe(403);
    expect(setCookieValue(switched, SESSION_COOKIE)).toBeUndefined();
    const signedOut = await app.request("/auth/logout/current", {
      method: "POST",
      headers: { host: CANVAS_HOST, cookie: both, "sec-fetch-site": "same-origin" },
    });
    expect(signedOut.status).toBe(403);
    expect(setCookieValue(signedOut, SESSION_COOKIE)).toBeUndefined();
    // The chooser itself only renders on the instance host.
    const chooser = await app.request(`/auth/accounts?account=${owner.id}`, {
      headers: { host: CANVAS_HOST, cookie: both },
    });
    expect(chooser.status).toBe(302);
    expect(chooser.headers.get("location")).toBe(
      `https://${APEX}/auth/accounts?account=${owner.id}`,
    );
  });

  it("won't switch to an account the browser doesn't hold, and never redirects off-site", async () => {
    client = await makeTestDb(dialect);
    const { app, owner, otherToken, both } = await setup(client);
    const cookie = `${SESSION_COOKIE}=${otherToken}`;
    const refused = await app.request("/auth/switch", {
      method: "POST",
      headers: { host: APEX, cookie, "sec-fetch-site": "same-origin" },
      body: switchForm(owner.id, CANVAS_URL),
    });
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toContain("/auth/accounts");
    expect(setCookieValue(refused, SESSION_COOKIE)).toBeUndefined();

    const offsite = await app.request("/auth/switch", {
      method: "POST",
      headers: { host: APEX, cookie, "sec-fetch-site": "same-origin" },
      body: switchForm(owner.id, "https://evil.example/"),
    });
    expect(offsite.headers.get("location")).not.toContain("evil.example");

    // A held account with an off-site returnTo switches but lands on the dashboard.
    const held = await app.request("/auth/switch", {
      method: "POST",
      headers: { host: APEX, cookie: both, "sec-fetch-site": "same-origin" },
      body: switchForm(owner.id, "https://evil.example/"),
    });
    expect(held.status).toBe(303);
    expect(held.headers.get("location")).toBe("/");
  });

  it("signing out of the current account hands over to the held one", async () => {
    client = await makeTestDb(dialect);
    const { app, ownerToken, both } = await setup(client);
    const res = await app.request("/auth/logout/current", {
      method: "POST",
      headers: { host: APEX, cookie: both, "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(setCookieValue(res, SESSION_COOKIE)).toBe(ownerToken);
  });

  it("signs out of every account on /auth/logout, but ignores a cross-site navigation there", async () => {
    client = await makeTestDb(dialect);
    const { app, both } = await setup(client);
    const cross = await app.request("/auth/logout", {
      headers: { host: APEX, cookie: both, "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(302);
    expect(cross.headers.get("location")).toBe("/");
    expect(setCookieValue(cross, SESSION_COOKIE)).toBeUndefined();

    const own = await app.request("/auth/logout", {
      headers: { host: APEX, cookie: both, "sec-fetch-site": "same-origin" },
    });
    expect(own.headers.get("location")).toBe("/welcome");
    expect(setCookieValue(own, SESSION_COOKIE)).toBe("");
    expect(setCookieValue(own, ACCOUNTS_COOKIE)).toBe("");
    const after = await app.request("/api/me", { headers: { host: APEX, cookie: both } });
    expect(after.status).toBe(401); // both sessions are gone
  });

  it("'Add another account' asks the IdP for its account picker", async () => {
    client = await makeTestDb(dialect);
    const { app, otherToken } = await setup(client);
    // A single-account browser goes from the chooser straight to adding one.
    const res = await app.request(`/auth/accounts?returnTo=${encodeURIComponent(CANVAS_URL)}`, {
      headers: { host: APEX, cookie: `${SESSION_COOKIE}=${otherToken}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/auth/login?add=1&returnTo=${encodeURIComponent(CANVAS_URL)}`,
    );
  });
});

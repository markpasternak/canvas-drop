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
import { kvRepository } from "../db/repositories/kv.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { memStorage } from "../storage/mem.js";
import type { AppEnv } from "./types.js";

/**
 * Security regressions (audit run-1, tier A): in subdomain mode a canvas author's
 * script runs on `{slug}.{base}`, where the parent-domain session cookie is sent and
 * the page's own fetches are same-origin. Session-authenticated platform routes must
 * not be usable from there, and editor-written draft HTML must not run with the
 * dashboard origin's authority.
 */

const silent = pino({ level: "silent" });
const BASE = "https://canvases.example.com";
const APEX = "canvases.example.com";
const ATTACKER_HOST = "attacker.canvases.example.com";

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

async function* folder(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    yield { path, bytes: new TextEncoder().encode(content) };
  }
}

/**
 * Mallory publishes `attacker`. Victim owns a private canvas titled PRIVATE-VICTIM.
 * Carol owns `target` (whole_org, backend on) holding a shared KV secret the victim
 * may read. Mallory is an editor on the victim's `shared` canvas.
 */
async function setup(client: DbClient) {
  const users = usersRepository(client);
  const mk = (who: string) =>
    users.upsert({
      providerSub: `oidc:${who}`,
      email: `${who}@example.com`,
      name: who,
      isAdmin: false,
    });
  const mallory = await mk("mallory");
  const victim = await mk("victim");
  const carol = await mk("carol");

  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });

  const attacker = await canvases.create({
    ownerId: mallory.id,
    slug: "attacker",
    apiKeyHash: "h-attacker",
  });
  await engine.deploy(attacker, "api", folder({ "index.html": "<h1>hi</h1>" }), mallory.id);
  await canvases.setAccess(attacker.id, "whole_org");

  const privateCv = await canvases.create({
    ownerId: victim.id,
    slug: "victim-private",
    apiKeyHash: "h-victim-private",
    title: "PRIVATE-VICTIM",
  });
  await engine.deploy(privateCv, "api", folder({ "index.html": "<h1>mine</h1>" }), victim.id);
  await canvases.setAccess(privateCv.id, "private");

  const shared = await canvases.create({
    ownerId: victim.id,
    slug: "shared",
    apiKeyHash: "h-shared",
  });
  await engine.deploy(shared, "api", folder({ "index.html": "<h1>shared</h1>" }), victim.id);
  await canvases.addAllowlistEntry({
    canvasId: shared.id,
    principalKind: "member",
    userId: mallory.id,
    role: "editor",
  });

  const target = await canvases.create({
    ownerId: carol.id,
    slug: "target",
    apiKeyHash: "h-target",
    backendEnabled: true,
  });
  await engine.deploy(target, "api", folder({ "index.html": "<h1>target</h1>" }), carol.id);
  await canvases.setAccess(target.id, "whole_org");
  await kvRepository(client).set(target.id, "shared", "secret", "CAROL-SECRET", carol.id);

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
    engine,
    audit: createAuditLog(auditRepository(client), silent),
    peerIp: () => "8.8.8.8",
  });

  const issuer = new Hono<AppEnv>();
  issuer.get("/:uid", async (c) => {
    await sessionSvc.issue(c, c.req.param("uid"));
    return c.text("ok");
  });
  const cookieFor = async (uid: string) => {
    const res = await issuer.request(`/${uid}`);
    for (const sc of res.headers.getSetCookie()) {
      const m = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(sc);
      if (m) return `${SESSION_COOKIE}=${decodeURIComponent(m[1] ?? "")}`;
    }
    throw new Error("no session cookie issued");
  };

  return {
    app,
    canvases,
    privateCv,
    shared,
    victimCookie: await cookieFor(victim.id),
    malloryCookie: await cookieFor(mallory.id),
  };
}

/** Headers a browser sends for a script's own fetch on the page's host. */
function sameOriginOn(host: string, cookie: string, extra: Record<string, string> = {}) {
  return {
    host,
    cookie,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    accept: "application/json",
    ...extra,
  };
}

describe.each(DIALECTS)("canvas-host isolation [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("control: the dashboard (apex) lists the signed-in user's canvases", async () => {
    client = await makeTestDb(dialect);
    const { app, victimCookie } = await setup(client);
    const res = await app.request(`${BASE}/api/canvases`, {
      headers: sameOriginOn(APEX, victimCookie),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("PRIVATE-VICTIM");
  });

  it("a canvas page cannot read the visitor's management API on its own host", async () => {
    client = await makeTestDb(dialect);
    const { app, victimCookie } = await setup(client);
    const res = await app.request(`https://${ATTACKER_HOST}/api/canvases`, {
      headers: sameOriginOn(ATTACKER_HOST, victimCookie),
    });
    const body = await res.text();
    expect(body).not.toContain("PRIVATE-VICTIM");
    expect(res.status).not.toBe(200);
  });

  it("a canvas page cannot change the visitor's canvas settings on its own host", async () => {
    client = await makeTestDb(dialect);
    const { app, canvases, privateCv, victimCookie } = await setup(client);
    const res = await app.request(
      `https://${ATTACKER_HOST}/api/canvases/${privateCv.id}/settings`,
      {
        method: "PATCH",
        headers: sameOriginOn(ATTACKER_HOST, victimCookie, { "content-type": "application/json" }),
        body: JSON.stringify({ title: "OWNED-BY-CANVAS" }),
      },
    );
    expect((await canvases.findById(privateCv.id))?.title).toBe("PRIVATE-VICTIM");
    expect(res.status).not.toBe(200);
  });

  it("control: the runtime API on the base host refuses a foreign canvas Origin", async () => {
    client = await makeTestDb(dialect);
    const { app, victimCookie } = await setup(client);
    const res = await app.request(`${BASE}/v1/c/target/kv/secret`, {
      headers: {
        ...sameOriginOn(APEX, victimCookie),
        "sec-fetch-site": "same-site",
        origin: `https://${ATTACKER_HOST}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("a canvas page cannot read another canvas's KV via same-origin /v1 on its own host", async () => {
    client = await makeTestDb(dialect);
    const { app, victimCookie } = await setup(client);
    // A same-origin GET carries no Origin header (Fetch standard).
    const res = await app.request(`https://${ATTACKER_HOST}/v1/c/target/kv/secret`, {
      headers: sameOriginOn(ATTACKER_HOST, victimCookie),
    });
    expect(await res.text()).not.toContain("CAROL-SECRET");
    expect(res.status).not.toBe(200);
  });

  it("an editor's draft HTML is not served as an unsandboxed document on the dashboard origin", async () => {
    client = await makeTestDb(dialect);
    const { app, shared, malloryCookie, victimCookie } = await setup(client);
    const page = "<script>/* editor-controlled */</script><h1>draft</h1>";
    const put = await app.request(
      `${BASE}/api/canvases/${shared.id}/draft/file?path=page.html&mode=create`,
      {
        method: "PUT",
        headers: sameOriginOn(APEX, malloryCookie, { "content-type": "text/html" }),
        body: page,
      },
    );
    expect(put.status).toBe(200);

    // The owner follows "Open full preview" (a top-level navigation on the apex).
    for (const path of [
      `/api/canvases/${shared.id}/preview/page.html`,
      `/api/canvases/${shared.id}/draft/file?path=page.html`,
    ]) {
      const res = await app.request(`${BASE}${path}`, {
        headers: {
          host: APEX,
          cookie: victimCookie,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      });
      expect(res.status, path).toBe(200);
      const active = (res.headers.get("content-type") ?? "").startsWith("text/html");
      const csp = res.headers.get("content-security-policy") ?? "";
      const disposition = res.headers.get("content-disposition") ?? "";
      // Safe iff the bytes cannot run as a dashboard-origin document.
      expect(
        !active || /(^|;)\s*sandbox\b/.test(csp) || disposition.startsWith("attachment"),
        `${path}: content-type=${res.headers.get("content-type")} csp=${csp || "(none)"}`,
      ).toBe(true);
    }
  });
});

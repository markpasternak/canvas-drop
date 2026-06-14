import { type Config, loadConfig } from "@canvas-drop/shared";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createAuditLog } from "./audit/audit-log.js";
import { devStrategy } from "./auth/dev.js";
import { sessionService } from "./auth/session.js";
import type { DbClient } from "./db/factory.js";
import { auditRepository } from "./db/repositories/audit.js";
import { canvasesRepository } from "./db/repositories/canvases.js";
import { draftsRepository } from "./db/repositories/drafts.js";
import { sessionsRepository } from "./db/repositories/sessions.js";
import { usersRepository } from "./db/repositories/users.js";
import { versionsRepository } from "./db/repositories/versions.js";
import { makeTestDb } from "./db/testing.js";
import { deployEngine } from "./deploy/engine.js";
import { memStorage } from "./storage/mem.js";

const silent = pino({ level: "silent" });
const devConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_DEV_USER_EMAIL: "mark@example.com",
  CANVAS_DROP_ADMIN_EMAILS: "mark@example.com",
});

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function app(client: DbClient, config: Config = devConfig) {
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

describe("buildApp", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("GET /healthz returns 200 with db: ok when the database is reachable", async () => {
    client = await makeTestDb("sqlite");
    const res = await app(client).request("/healthz");
    expect(res.status).toBe(200);
    expect(await jsonOf<{ status: string; db: string }>(res)).toMatchObject({
      status: "ok",
      db: "ok",
    });
  });

  it("GET /healthz returns 503 when the DB ping fails", async () => {
    client = await makeTestDb("sqlite");
    await client.close(); // closing the underlying handle makes the ping throw
    const res = await app(client).request("/healthz");
    expect(res.status).toBe(503);
    expect((await jsonOf<{ db: string }>(res)).db).toBe("error");
    client = await makeTestDb("sqlite"); // replace so afterEach close() is safe
  });

  it("dev mode: the management API resolves as the logged-in dev user", async () => {
    client = await makeTestDb("sqlite");
    // /api/canvases is behind the gateway; a 200 list (not 401) proves the dev
    // user was authenticated and the management API is wired.
    const res = await app(client).request("/api/canvases", { headers: { host: "localhost:3000" } });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ canvases: unknown[] }>(res)).canvases).toEqual([]);
    // §12.4 baseline now reaches JSON API responses (M7) — previously absent.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("an unknown canvas slug 404s on both the content path and the runtime API (no existence leak)", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client);
    const canvas = await a.request("/c/abc/index.html", { headers: { host: "localhost:3000" } });
    expect(canvas.status).toBe(404); // canvasAccess → not_found (no existence leak)

    // Platform API (M6) is now wired: an unknown slug resolves through canvasAccess
    // and 404s with not_found — same no-existence-leak behavior as the content path.
    const platform = await a.request("/v1/c/abc/kv/x", { headers: { host: "localhost:3000" } });
    expect(platform.status).toBe(404);
    expect((await jsonOf<{ code: string }>(platform)).code).toBe("NOT_FOUND");
  });

  it("direct browser visits to API errors get the designed HTML page", async () => {
    client = await makeTestDb("sqlite");
    const res = await app(client).request("/api/canvases/missing", {
      headers: { host: "localhost:3000", accept: "text/html" },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("vary")).toContain("Accept");
    const html = await res.text();
    expect(html).toContain("Canvasdrop");
    expect(html).toContain("Page not found");
    expect(html).toContain("/api/canvases/missing");
  });

  it("end-to-end: create → deploy ZIP → the canvas is live at its URL", async () => {
    const { zipSync } = await import("fflate");
    const { Buffer } = await import("node:buffer");
    client = await makeTestDb("sqlite");
    const a = app(client);

    // create a canvas as the dev user
    const created = await jsonOf<{ id: string; slug: string }>(
      await a.request("/api/canvases", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          "Sec-Fetch-Site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );

    // deploy a ZIP with an index.html via the management route
    const zip = Buffer.from(zipSync({ "index.html": new TextEncoder().encode("<h1>live</h1>") }));
    const deploy = await a.request(`/api/canvases/${created.id}/deploy/zip`, {
      method: "POST",
      headers: { host: "localhost:3000", "Sec-Fetch-Site": "same-origin" },
      body: zip,
    });
    expect(deploy.status).toBe(200);

    // the canvas is now live at its URL (owner = dev user, so authorized)
    const live = await a.request(`/c/${created.slug}/index.html`, {
      headers: { host: "localhost:3000" },
    });
    expect(live.status).toBe(200);
    expect(await live.text()).toContain("live");
    expect(live.headers.get("ETag")).toBeTruthy();
    expect(live.headers.get("X-Content-Type-Options")).toBe("nosniff");

    // root serves index.html too
    expect(
      (await a.request(`/c/${created.slug}/`, { headers: { host: "localhost:3000" } })).status,
    ).toBe(200);
  });

  it("the auth gateway rejects an unauthenticated request in non-dev mode", async () => {
    client = await makeTestDb("sqlite");
    // A proxy-mode app with no valid identity on the request → 401 at the gateway.
    const proxyConfig = loadConfig({
      CANVAS_DROP_AUTH_MODE: "proxy",
      CANVAS_DROP_URL_MODE: "subdomain",
      CANVAS_DROP_BASE_URL: "https://canvases.example.com",
      CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
      CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
      CANVAS_DROP_TRUSTED_PROXY_IPS: "10.0.0.0/8",
    });
    const { proxyStrategy } = await import("./auth/proxy.js");
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const storage = memStorage();
    const a = buildApp({
      config: proxyConfig,
      db: client,
      rootLogger: silent,
      strategy: proxyStrategy(proxyConfig),
      users: usersRepository(client),
      canvases,
      versions,
      drafts,
      storage,
      engine: deployEngine({
        config: proxyConfig,
        canvases,
        versions,
        drafts,
        storage,
        log: silent,
      }),
      audit: createAuditLog(auditRepository(client), silent),
      peerIp: () => "8.8.8.8",
    });
    const res = await a.request("/api/canvases", { headers: { host: "canvases.example.com" } });
    expect(res.status).toBe(401);
  });

  it("browser unauthenticated requests in proxy mode get an HTML 401 page", async () => {
    client = await makeTestDb("sqlite");
    const proxyConfig = loadConfig({
      CANVAS_DROP_AUTH_MODE: "proxy",
      CANVAS_DROP_URL_MODE: "subdomain",
      CANVAS_DROP_BASE_URL: "https://canvases.example.com",
      CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
      CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
      CANVAS_DROP_TRUSTED_PROXY_IPS: "10.0.0.0/8",
    });
    const { proxyStrategy } = await import("./auth/proxy.js");
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const storage = memStorage();
    const a = buildApp({
      config: proxyConfig,
      db: client,
      rootLogger: silent,
      strategy: proxyStrategy(proxyConfig),
      users: usersRepository(client),
      canvases,
      versions,
      drafts,
      storage,
      engine: deployEngine({
        config: proxyConfig,
        canvases,
        versions,
        drafts,
        storage,
        log: silent,
      }),
      audit: createAuditLog(auditRepository(client), silent),
      peerIp: () => "8.8.8.8",
    });

    const res = await a.request("/api/canvases", {
      headers: { host: "canvases.example.com", accept: "text/html" },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Sign in required");
  });

  it("public legal pages are reachable WITHOUT auth in proxy mode (mounted before the gateway)", async () => {
    client = await makeTestDb("sqlite");
    // Same proxy config where /api/canvases 401s above — here the unauthenticated
    // request must succeed, proving /privacy + /terms sit ahead of the gateway so
    // Google's signed-out consent-screen reviewers can open them.
    const proxyConfig = loadConfig({
      CANVAS_DROP_AUTH_MODE: "proxy",
      CANVAS_DROP_URL_MODE: "subdomain",
      CANVAS_DROP_BASE_URL: "https://canvases.example.com",
      CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
      CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
      CANVAS_DROP_TRUSTED_PROXY_IPS: "10.0.0.0/8",
    });
    const { proxyStrategy } = await import("./auth/proxy.js");
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const storage = memStorage();
    const a = buildApp({
      config: proxyConfig,
      db: client,
      rootLogger: silent,
      strategy: proxyStrategy(proxyConfig),
      users: usersRepository(client),
      canvases,
      versions,
      drafts,
      storage,
      engine: deployEngine({
        config: proxyConfig,
        canvases,
        versions,
        drafts,
        storage,
        log: silent,
      }),
      audit: createAuditLog(auditRepository(client), silent),
      peerIp: () => "8.8.8.8",
    });

    for (const path of ["/privacy", "/terms"]) {
      const res = await a.request(path, {
        headers: { host: "canvases.example.com", accept: "text/html" },
      });
      expect(res.status, `${path} should be public`).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  // Login throttle keys on the RESOLVED client IP, so behind a trusted proxy it is
  // per-user (not one global bucket) — and an untrusted peer cannot evade it via XFF.
  function loginApp(cfg: Config, peer: string) {
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const storage = memStorage();
    return buildApp({
      config: cfg,
      db: client,
      rootLogger: silent,
      strategy: devStrategy(cfg),
      users: usersRepository(client),
      canvases,
      versions,
      drafts,
      storage,
      engine: deployEngine({ config: cfg, canvases, versions, drafts, storage, log: silent }),
      audit: createAuditLog(auditRepository(client), silent),
      sessionSvc: sessionService(cfg, sessionsRepository(client)),
      peerIp: () => peer,
    });
  }
  const loginCfg = (perMin: string) =>
    loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_DEV_USER_EMAIL: "mark@example.com",
      CANVAS_DROP_ADMIN_EMAILS: "mark@example.com",
      CANVAS_DROP_TRUSTED_PROXY_IPS: "10.0.0.0/8",
      CANVAS_DROP_RATELIMIT_LOGIN_PER_MIN: perMin,
    });

  it("login throttle buckets per real client IP behind a trusted proxy", async () => {
    client = await makeTestDb("sqlite");
    const a = loginApp(loginCfg("1"), "10.0.0.1"); // peer is a trusted proxy hop
    const hit = (xff: string) => a.request("/auth/login", { headers: { "x-forwarded-for": xff } });
    // Same client twice → second is throttled (429). (Passing the throttle yields a
    // 404 here: dev mode mounts no /auth/login route — what matters is "not 429".)
    expect((await hit("1.1.1.1")).status).not.toBe(429);
    expect((await hit("1.1.1.1")).status).toBe(429);
    // A different real client behind the same proxy gets its OWN bucket.
    expect((await hit("2.2.2.2")).status).not.toBe(429);
  });

  it("login throttle ignores X-Forwarded-For from an untrusted peer (no evasion)", async () => {
    client = await makeTestDb("sqlite");
    const a = loginApp(loginCfg("1"), "8.8.8.8"); // untrusted peer → XFF is not trusted
    const hit = (xff: string) => a.request("/auth/login", { headers: { "x-forwarded-for": xff } });
    // Differing XFF does not create separate buckets — both share the peer's bucket.
    expect((await hit("1.1.1.1")).status).not.toBe(429);
    expect((await hit("2.2.2.2")).status).toBe(429);
  });
});

import { type Config, loadConfig } from "@canvas-drop/shared";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createAuditLog } from "./audit/audit-log.js";
import { devStrategy } from "./auth/dev.js";
import { sessionService } from "./auth/session.js";
import type { DbClient } from "./db/factory.js";
import { auditRepository } from "./db/repositories/audit.js";
import { sessionsRepository } from "./db/repositories/sessions.js";
import { usersRepository } from "./db/repositories/users.js";
import { makeTestDb } from "./db/testing.js";

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
  return buildApp({
    config,
    db: client,
    rootLogger: silent,
    strategy: devStrategy(config),
    users: usersRepository(client),
    audit: createAuditLog(auditRepository(client), silent),
    sessionSvc: sessionService(config, sessionsRepository(client)),
    clientIp: () => "127.0.0.1",
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

  it("dev mode: a dashboard route resolves as the logged-in dev user", async () => {
    client = await makeTestDb("sqlite");
    // /api/* is a dashboard role → behind the gateway → reaches the not-built
    // placeholder only because auth succeeded (dev user). A 404 not_implemented
    // (not 401) proves the gateway authenticated the request.
    const res = await app(client).request("/api/canvases", { headers: { host: "localhost:3000" } });
    expect(res.status).toBe(404);
    expect((await jsonOf<{ error: string; role: string }>(res)).role).toBe("dashboard");
  });

  it("canvas + platform roles are wired and answer honestly (not crash)", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client);
    const canvas = await a.request("/c/abc/index.html", { headers: { host: "localhost:3000" } });
    expect(canvas.status).toBe(404);
    expect(await jsonOf<{ role: string; canvasSlug: string }>(canvas)).toMatchObject({
      error: "not_implemented",
      role: "canvas",
      canvasSlug: "abc",
    });

    const platform = await a.request("/v1/c/abc/kv/x", { headers: { host: "localhost:3000" } });
    expect((await jsonOf<{ role: string }>(platform)).role).toBe("platform-api");
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
    const a = buildApp({
      config: proxyConfig,
      db: client,
      rootLogger: silent,
      strategy: proxyStrategy(proxyConfig),
      users: usersRepository(client),
      audit: createAuditLog(auditRepository(client), silent),
      clientIp: () => "8.8.8.8",
    });
    const res = await a.request("/api/canvases", { headers: { host: "canvases.example.com" } });
    expect(res.status).toBe(401);
  });
});

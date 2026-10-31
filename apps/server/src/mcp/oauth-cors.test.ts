import { loadConfig } from "@canvas-drop/shared";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
import { sessionBackedStrategy, sessionService } from "../auth/session.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { memStorage } from "../storage/mem.js";
import { OAUTH_CORS_PATHS } from "./routes.js";

/**
 * Security regression (audit run-1, #17): the MCP OAuth router's CORS covers only its
 * own endpoints. It used to be mounted with a wildcard `cors()` at root, so every app
 * route answered `Access-Control-Allow-Origin: *`, which in dev mode (or a
 * credential-less proxy setup) let any website read management responses.
 */

const silent = pino({ level: "silent" });
const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_BASE_URL: "http://localhost:3000",
});
const EVIL = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };

function appFor(client: DbClient) {
  const users = usersRepository(client);
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  const sessionSvc = sessionService(config, sessionsRepository(client));
  return buildApp({
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
}

describe.each(DIALECTS)("MCP OAuth CORS scope (%s)", (dialect) => {
  let client: DbClient | undefined;
  afterEach(async () => {
    await client?.close();
  });

  it("non-OAuth routes answer a cross-site request without wildcard CORS", async () => {
    client = await makeTestDb(dialect);
    const app = appFor(client);
    for (const path of ["/api/me", "/api/canvases", "/no-such-path"]) {
      const res = await app.request(path, { headers: EVIL });
      expect(res.headers.get("access-control-allow-origin"), path).toBeNull();
      const pre = await app.request(path, {
        method: "OPTIONS",
        headers: { ...EVIL, "access-control-request-method": "GET" },
      });
      expect(pre.headers.get("access-control-allow-origin"), `${path} preflight`).toBeNull();
    }
  });

  it("the OAuth endpoints keep CORS for browser-based MCP clients", async () => {
    client = await makeTestDb(dialect);
    const app = appFor(client);
    for (const path of OAUTH_CORS_PATHS) {
      const pre = await app.request(path, {
        method: "OPTIONS",
        headers: { ...EVIL, "access-control-request-method": "POST" },
      });
      expect(pre.headers.get("access-control-allow-origin"), path).toBe("*");
    }
    const meta = await app.request("/.well-known/oauth-authorization-server", { headers: EVIL });
    expect(meta.status).toBe(200);
    expect(meta.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await meta.json()) as { registration_endpoint?: string };
    expect(body.registration_endpoint).toBe("http://localhost:3000/register");
  });

  it("the bearer-only /mcp endpoint keeps CORS and exposes its auth challenge", async () => {
    client = await makeTestDb(dialect);
    const app = appFor(client);
    const pre = await app.request("/mcp", {
      method: "OPTIONS",
      headers: {
        ...EVIL,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    const unauth = await app.request("/mcp", { method: "POST", headers: EVIL });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("access-control-allow-origin")).toBe("*");
    expect(unauth.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
  });
});

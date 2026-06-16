import { type Config, loadConfig } from "@canvas-drop/shared";
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
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { memStorage } from "../storage/mem.js";

const silent = pino({ level: "silent" });

function app(client: DbClient, config: Config) {
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

const onConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_ADMIN_EMAILS: "a@example.com",
});
const offConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_ADMIN_EMAILS: "a@example.com",
  CANVAS_DROP_MCP: "off",
});

describe("MCP routes (config-gated mount)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("serves OAuth authorization-server + protected-resource metadata when MCP is on (AE4)", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, onConfig);

    const as = await a.request("/.well-known/oauth-authorization-server");
    expect(as.status).toBe(200);
    const meta = (await as.json()) as Record<string, string>;
    expect(meta.issuer).toBeTruthy();
    expect(meta.authorization_endpoint).toContain("/authorize");
    expect(meta.token_endpoint).toContain("/token");
    expect(meta.registration_endpoint).toContain("/register");

    const prm = await a.request("/.well-known/oauth-protected-resource");
    expect(prm.status).toBe(200);
  });

  it("supports Dynamic Client Registration when MCP is on (AE4)", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, onConfig);
    const res = await a.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Agent",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(201);
    const reg = (await res.json()) as Record<string, unknown>;
    expect(reg.client_id).toBeTruthy();
  });

  it("does NOT serve the OAuth surface when MCP is disabled (AE3)", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, offConfig);
    // The MCP router is not mounted, so the metadata document is absent — the SPA
    // catch-all may answer the path, but it is never the OAuth metadata JSON.
    const meta = await a.request("/.well-known/oauth-authorization-server");
    expect(await meta.text()).not.toContain("authorization_endpoint");
    // DCR cannot succeed when the surface is off.
    const reg = await a.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://c.example/cb"] }),
    });
    expect(reg.status).not.toBe(201);
    // /mcp is not mounted either — never a successful tool surface.
    expect((await a.request("/mcp", { method: "POST" })).status).not.toBe(200);
  });

  it("rejects an unauthenticated /mcp call with a 401 carrying the resource_metadata hint", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, onConfig);
    const res = await a.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("rejects an invalid bearer token on /mcp", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, onConfig);
    const res = await a.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});

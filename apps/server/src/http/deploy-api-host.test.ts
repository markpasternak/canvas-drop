import { loadConfig } from "@canvas-drop/shared";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
import { sessionBackedStrategy, sessionService } from "../auth/session.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
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

/**
 * A dedicated Deploy API host (`CANVAS_DROP_API_BASE_URL = https://api.{base}`) in
 * subdomain mode. The MCP `deploy` block advertises this host, so the keyed Deploy API
 * must answer on it instead of treating `api` as a canvas slug, and nothing else may.
 */

const silent = pino({ level: "silent" });
const BASE = "https://canvases.example.com";
const API = "https://api.canvases.example.com";

const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: BASE,
  CANVAS_DROP_API_BASE_URL: API,
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_OIDC_ISSUER: "https://idp.example.com",
  CANVAS_DROP_OIDC_CLIENT_ID: "id",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
});

async function setup(client: DbClient) {
  const users = usersRepository(client);
  const owner = await users.upsert({
    providerSub: "oidc:owner",
    email: "owner@example.com",
    name: "owner",
    isAdmin: false,
  });
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
  const key = generateApiKey();
  const canvas = await canvases.create({
    ownerId: owner.id,
    slug: "deck",
    apiKeyHash: hashApiKey(key),
  });
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
  return { app, canvases, canvas, key };
}

const bearer = (key: string) => ({
  host: "api.canvases.example.com",
  authorization: `Bearer ${key}`,
});

describe.each(DIALECTS)("deploy API on a dedicated API host [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("answers the keyed status read-back on the API host", async () => {
    client = await makeTestDb(dialect);
    const { app, canvas, key } = await setup(client);
    const res = await app.request(`${API}/v1/canvases/${canvas.id}`, { headers: bearer(key) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(canvas.id);
  });

  it("accepts a regenerated key there and rejects the old one", async () => {
    client = await makeTestDb(dialect);
    const { app, canvases, canvas, key } = await setup(client);
    const fresh = generateApiKey();
    await canvases.regenerateApiKey(canvas.id, hashApiKey(fresh));
    const url = `${API}/v1/canvases/${canvas.id}/uploads`;
    const init = (k: string) => ({
      method: "POST",
      headers: { ...bearer(k), "content-type": "application/json" },
      body: JSON.stringify({ manifest: [] }),
    });
    expect((await app.request(url, init(key))).status).toBe(401);
    expect((await app.request(url, init(fresh))).status).not.toBe(401);
  });

  it("rejects a missing key with 401, not 404", async () => {
    client = await makeTestDb(dialect);
    const { app, canvas } = await setup(client);
    const res = await app.request(`${API}/v1/canvases/${canvas.id}`, {
      headers: { host: "api.canvases.example.com" },
    });
    expect(res.status).toBe(401);
  });

  it("serves nothing else on the API host", async () => {
    client = await makeTestDb(dialect);
    const { app } = await setup(client);
    for (const path of ["/", "/api/canvases", "/auth/login", "/mcp", "/v1/c/deck/kv/x"]) {
      const res = await app.request(`${API}${path}`, {
        headers: { host: "api.canvases.example.com" },
      });
      expect(res.status, path).toBe(404);
    }
  });

  it("still serves the Deploy API on the base host", async () => {
    client = await makeTestDb(dialect);
    const { app, canvas, key } = await setup(client);
    const res = await app.request(`${BASE}/v1/canvases/${canvas.id}`, {
      headers: { host: "canvases.example.com", authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });
});

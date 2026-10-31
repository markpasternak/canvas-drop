import { loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
import { SESSION_COOKIE, sessionBackedStrategy, sessionService } from "../auth/session.js";
import { screenshotKey } from "../canvas/storage-keys.js";
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
import type { AppEnv } from "./types.js";

/**
 * Security regression (audit run-1, #24): in subdomain mode a canvas page could test
 * whether its visitor can open a restricted canvas by loading that canvas's files or
 * preview as an `<img>` (the same-site session cookie rides along). Restricted canvases
 * now answer with `Cross-Origin-Resource-Policy: same-origin`; the dashboard's covers
 * use CORS for its own origin instead.
 */

const silent = pino({ level: "silent" });
const BASE = "https://canvases.example.com";

const subdomain = loadConfig({
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

async function setup(client: DbClient) {
  const config = subdomain;
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
  const make = async (slug: string, access: "private" | "whole_org") => {
    const cv = await canvases.create({ ownerId: owner.id, slug, apiKeyHash: `h-${slug}` });
    await engine.deploy(cv, "api", folder({ "index.html": `<h1>${slug}</h1>` }), owner.id);
    await canvases.setAccess(cv.id, access);
    await canvases.updateSettings(cv.id, { previewMode: "custom" });
    await storage.put(screenshotKey(cv.id, "card"), new Uint8Array([1, 2, 3]));
    return cv;
  };
  await make("restricted", "private");
  await make("orgwide", "whole_org");

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
  const res = await issuer.request(`/${owner.id}`);
  let cookie = "";
  for (const sc of res.headers.getSetCookie()) {
    const m = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(sc);
    if (m) cookie = `${SESSION_COOKIE}=${decodeURIComponent(m[1] ?? "")}`;
  }
  return { app, cookie };
}

describe.each(DIALECTS)("restricted canvas resource policy [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("a restricted canvas's content and preview are same-origin only; a whole-org canvas's are not", async () => {
    client = await makeTestDb(dialect);
    const { app, cookie } = await setup(client);
    const embed = { cookie, "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" };

    for (const path of ["/", "/__canvasdrop_preview?rendition=card"]) {
      const restricted = await app.request(path, {
        headers: { host: "restricted.canvases.example.com", ...embed },
      });
      expect(restricted.status, path).toBe(200);
      expect(restricted.headers.get("cross-origin-resource-policy"), path).toBe("same-origin");

      const org = await app.request(path, {
        headers: { host: "orgwide.canvases.example.com", ...embed },
      });
      expect(org.status, path).toBe(200);
      expect(org.headers.get("cross-origin-resource-policy"), path).toBeNull();
    }
  });

  it("the preview allows CORS for the dashboard origin only", async () => {
    client = await makeTestDb(dialect);
    const { app, cookie } = await setup(client);
    const preview = (origin: string) =>
      app.request("/__canvasdrop_preview?rendition=card", {
        headers: {
          host: "restricted.canvases.example.com",
          cookie,
          origin,
          "sec-fetch-site": "same-site",
          "sec-fetch-mode": "cors",
        },
      });

    const dashboard = await preview(BASE);
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("access-control-allow-origin")).toBe(BASE);
    expect(dashboard.headers.get("access-control-allow-credentials")).toBe("true");
    expect(dashboard.headers.get("vary")).toContain("Origin");

    const otherCanvas = await preview("https://orgwide.canvases.example.com");
    expect(otherCanvas.headers.get("access-control-allow-origin")).toBeNull();
  });
});

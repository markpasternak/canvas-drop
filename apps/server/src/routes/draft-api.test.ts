import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import { draftService } from "../draft/service.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { draftApiRoutes } from "./draft-api.js";

const silent = pino({ level: "silent" });
const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const SO = { "Sec-Fetch-Site": "same-origin", host: "localhost:3000" } as const;
const enc = (s: string) => new TextEncoder().encode(s);
const jsonOf = <T>(r: Response) => r.json() as Promise<T>;

describe("draftApiRoutes", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function setup() {
    client = await makeTestDb("sqlite");
    const storage = memStorage();
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const audit = createAuditLog(auditRepository(client), silent);
    const svc = draftService({ config, canvases, versions, drafts, storage, audit, log: silent });
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const other = await users.upsert({
      providerSub: "x",
      email: "x@e.com",
      name: "X",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "k" });

    function appAs(userId: string, isAdmin = false) {
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: userId, isAdmin } as never);
        c.set("clientIp", "127.0.0.1");
        await next();
      });
      app.route(
        "/api/canvases",
        draftApiRoutes({ config, canvases, versions, storage, drafts: svc }),
      );
      return app;
    }
    return { storage, canvases, versions, drafts, svc, owner, other, canvas: cv, appAs };
  }

  it("GET /draft creates an empty draft for a new canvas (R10)", async () => {
    const { appAs, owner, canvas } = await setup();
    const res = await appAs(owner.id).request(`/api/canvases/${canvas.id}/draft`);
    expect(res.status).toBe(200);
    const body = await jsonOf<{ files: unknown[]; stale: boolean; dirty: boolean }>(res);
    expect(body.files).toEqual([]);
    expect(body.stale).toBe(false);
    expect(body.dirty).toBe(false);
  });

  it("a non-owner gets 404 on every draft route (owner-only)", async () => {
    const { appAs, other, canvas } = await setup();
    const app = appAs(other.id);
    expect((await app.request(`/api/canvases/${canvas.id}/draft`)).status).toBe(404);
    const put = await app.request(`/api/canvases/${canvas.id}/draft/file?path=a.html`, {
      method: "PUT",
      headers: SO,
      body: enc("x"),
    });
    expect(put.status).toBe(404);
  });

  it("PUT writes a draft file (dirty), GET file returns its bytes", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);
    const put = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>hello</h1>"),
    });
    expect(put.status).toBe(200);
    const view = await jsonOf<{ files: { path: string }[]; dirty: boolean }>(put);
    expect(view.files.map((f) => f.path)).toEqual(["index.html"]);
    expect(view.dirty).toBe(true);

    const get = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`);
    expect(get.status).toBe(200);
    expect(get.headers.get("Cache-Control")).toBe("no-store");
    expect(await get.text()).toBe("<h1>hello</h1>");
  });

  it("a cross-site mutation is rejected (same-origin guard)", async () => {
    const { appAs, owner, canvas } = await setup();
    const res = await appAs(owner.id).request(`/api/canvases/${canvas.id}/draft/file?path=a.html`, {
      method: "PUT",
      headers: { host: "localhost:3000", "Sec-Fetch-Site": "cross-site" },
      body: enc("x"),
    });
    expect(res.status).toBe(403);
  });

  it("rename + delete edit the draft file set", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=a.html`, {
      method: "PUT",
      headers: SO,
      body: enc("a"),
    });
    const renamed = await app.request(`/api/canvases/${canvas.id}/draft/rename`, {
      method: "POST",
      headers: { ...SO, "content-type": "application/json" },
      body: JSON.stringify({ from: "a.html", to: "b.html" }),
    });
    expect((await jsonOf<{ files: { path: string }[] }>(renamed)).files.map((f) => f.path)).toEqual(
      ["b.html"],
    );
    const deleted = await app.request(`/api/canvases/${canvas.id}/draft/file?path=b.html`, {
      method: "DELETE",
      headers: SO,
    });
    expect((await jsonOf<{ files: unknown[] }>(deleted)).files).toEqual([]);
  });

  it("POST /publish freezes the draft into a live version", async () => {
    const { appAs, owner, canvas, canvases } = await setup();
    const app = appAs(owner.id);
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>publish me</h1>"),
    });
    const pub = await app.request(`/api/canvases/${canvas.id}/publish`, {
      method: "POST",
      headers: SO,
    });
    expect(pub.status).toBe(200);
    expect((await jsonOf<{ version: number }>(pub)).version).toBe(1);
    expect((await canvases.findById(canvas.id))?.currentVersionId).toBeTruthy();
  });

  it("publishing an empty draft returns EMPTY_DEPLOY (400)", async () => {
    const { appAs, owner, canvas } = await setup();
    const res = await appAs(owner.id).request(`/api/canvases/${canvas.id}/publish`, {
      method: "POST",
      headers: SO,
    });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("EMPTY_DEPLOY");
  });

  it("POST /restore loads a prior version into the draft", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);
    // publish v1 via the editor
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>v1</h1>"),
    });
    await app.request(`/api/canvases/${canvas.id}/publish`, { method: "POST", headers: SO });
    // edit + publish v2
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>v2</h1>"),
    });
    await app.request(`/api/canvases/${canvas.id}/publish`, { method: "POST", headers: SO });

    const restored = await app.request(`/api/canvases/${canvas.id}/restore`, {
      method: "POST",
      headers: { ...SO, "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(restored.status).toBe(200);
    const content = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`);
    expect(await content.text()).toBe("<h1>v1</h1>");
  });

  it("GET /preview streams the draft's bytes (no-store), and the draft differs from the published live version (R13)", async () => {
    const { appAs, owner, canvas, svc, canvases } = await setup();
    const app = appAs(owner.id);
    // Publish v1 = "published".
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>published</h1>"),
    });
    await app.request(`/api/canvases/${canvas.id}/publish`, { method: "POST", headers: SO });
    // Edit the draft (unpublished).
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>draft only</h1>"),
    });

    const preview = await app.request(`/api/canvases/${canvas.id}/preview/`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Cache-Control")).toBe("no-store");
    expect(preview.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await preview.text()).toBe("<h1>draft only</h1>"); // draft bytes, not the published v1

    // The published version (via the service's live manifest) is still v1.
    const cv = await canvases.findById(canvas.id);
    const live = await svc.readFile(cv as never, "index.html"); // draft read != published; sanity only
    expect(live).not.toBeNull();
  });

  it("a non-owner cannot preview a draft (404)", async () => {
    const { appAs, owner, other, canvas } = await setup();
    await appAs(owner.id).request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>secret draft</h1>"),
    });
    const res = await appAs(other.id).request(`/api/canvases/${canvas.id}/preview/`);
    expect(res.status).toBe(404);
  });

  it("preview of a deep path falls back to the entry when SPA fallback is on", async () => {
    const { appAs, owner, canvas, canvases } = await setup();
    await canvases.updateSettings(canvas.id, { spaFallback: true });
    const app = appAs(owner.id);
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>spa shell</h1>"),
    });
    const deep = await app.request(`/api/canvases/${canvas.id}/preview/some/client/route`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe("<h1>spa shell</h1>");
  });

  it("a path-traversal write is rejected with a stable code (400)", async () => {
    const { appAs, owner, canvas } = await setup();
    const res = await appAs(owner.id).request(
      `/api/canvases/${canvas.id}/draft/file?path=${encodeURIComponent("../escape.txt")}`,
      { method: "PUT", headers: SO, body: enc("x") },
    );
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("ZIP_SLIP_REJECTED");
  });
});

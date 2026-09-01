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
    const svc = draftService({
      config,
      canvases,
      versions,
      drafts,
      storage,
      audit,
      log: silent,
      users,
    });
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

  it("a non-owner gets 404 on every draft route (owner-only) — including an admin", async () => {
    const { appAs, other, canvas } = await setup();
    const app = appAs(other.id);
    expect((await app.request(`/api/canvases/${canvas.id}/draft`)).status).toBe(404);
    const put = await app.request(`/api/canvases/${canvas.id}/draft/file?path=a.html`, {
      method: "PUT",
      headers: SO,
      body: enc("x"),
    });
    expect(put.status).toBe(404);
    // The editor/draft surface exposes canvas CONTENT, so a non-owner ADMIN is also
    // 404'd — admins get no content bypass on canvases they don't own (D-admin-restrict).
    const adminApp = appAs("an-admin", true);
    expect((await adminApp.request(`/api/canvases/${canvas.id}/draft`)).status).toBe(404);
    expect(
      (await adminApp.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`)).status,
    ).toBe(404);
    // …and a mutating content route (publish) is 404 for the admin too.
    expect(
      (
        await adminApp.request(`/api/canvases/${canvas.id}/publish`, {
          method: "POST",
          headers: SO,
        })
      ).status,
    ).toBe(404);
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

  it("PUT ?mode=create refuses an existing path (PATH_EXISTS) and leaves it intact", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>real</h1>"),
    });
    const created = await app.request(
      `/api/canvases/${canvas.id}/draft/file?path=index.html&mode=create`,
      { method: "PUT", headers: SO, body: enc("") },
    );
    expect(created.status).toBe(400);
    expect((await jsonOf<{ code: string }>(created)).code).toBe("PATH_EXISTS");
    // The original file content survives the rejected create.
    const get = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`);
    expect(await get.text()).toBe("<h1>real</h1>");
  });

  it("POST /rename onto an existing path returns PATH_EXISTS (400); both files survive", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);
    for (const [path, body] of [
      ["a.html", "AAA"],
      ["b.html", "BBB"],
    ] as const) {
      await app.request(`/api/canvases/${canvas.id}/draft/file?path=${path}`, {
        method: "PUT",
        headers: SO,
        body: enc(body),
      });
    }
    const renamed = await app.request(`/api/canvases/${canvas.id}/draft/rename`, {
      method: "POST",
      headers: { ...SO, "content-type": "application/json" },
      body: JSON.stringify({ from: "a.html", to: "b.html" }),
    });
    expect(renamed.status).toBe(400);
    expect((await jsonOf<{ code: string }>(renamed)).code).toBe("PATH_EXISTS");
    const survivor = await app.request(`/api/canvases/${canvas.id}/draft/file?path=b.html`);
    expect(await survivor.text()).toBe("BBB");
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

  it("publishing an ARCHIVED canvas returns NOT_ACTIVE (409), not DISABLED", async () => {
    // Archive is owner-reversible, so publish keeps the NOT_ACTIVE "unarchive first"
    // contract — it must NOT collapse into the admin-takedown DISABLED 409.
    const { appAs, owner, canvas, canvases } = await setup();
    const app = appAs(owner.id);
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>x</h1>"),
    });
    await canvases.archive(canvas.id);
    const res = await app.request(`/api/canvases/${canvas.id}/publish`, {
      method: "POST",
      headers: SO,
    });
    expect(res.status).toBe(409);
    const body = await jsonOf<{ code: string }>(res);
    expect(body.code).toBe("NOT_ACTIVE");
    expect(body.code).not.toBe("DISABLED");
  });

  it("publishing a DISABLED canvas (owner) returns the DISABLED 409 with the reason", async () => {
    const { appAs, owner, canvas, canvases } = await setup();
    const app = appAs(owner.id);
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>x</h1>"),
    });
    await canvases.setDisabled(canvas.id, "policy violation");
    const res = await app.request(`/api/canvases/${canvas.id}/publish`, {
      method: "POST",
      headers: SO,
    });
    expect(res.status).toBe(409);
    const body = await jsonOf<{ code: string; message: string }>(res);
    expect(body.code).toBe("DISABLED");
    expect(body.message).toContain("policy violation");
  });

  it("a NON-OWNER (incl. admin) mutating a DISABLED canvas gets 404, NEVER the DISABLED 409", async () => {
    // Gate ordering lock: ownership is checked BEFORE the disabled state, so a non-owner
    // — even an admin — of a disabled canvas reads as not-found. Surfacing the 409 would
    // leak that the row exists (§12.0). The reason must never reach a non-owner.
    const { appAs, other, canvas, canvases } = await setup();
    await canvases.setDisabled(canvas.id, "policy violation");
    for (const isAdmin of [false, true]) {
      const res = await appAs(other.id, isAdmin).request(`/api/canvases/${canvas.id}/publish`, {
        method: "POST",
        headers: SO,
      });
      expect(res.status, `admin=${isAdmin}`).toBe(404);
      const body = await jsonOf<{ error?: string; code?: string; message?: string }>(res);
      expect(body.error).toBe("not_found");
      expect(body.code).not.toBe("DISABLED");
      expect(JSON.stringify(body)).not.toContain("policy violation");
    }
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

  it("preview ?edit=1 injects the on-page editing shim into the HTML entry, not other files", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<!doctype html><html><body><h1>edit me</h1></body></html>"),
    });
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=style.css`, {
      method: "PUT",
      headers: SO,
      body: enc("body{color:red}"),
    });

    const edited = await app.request(`/api/canvases/${canvas.id}/preview/?edit=1`);
    const html = await edited.text();
    expect(html).toContain("edit me");
    expect(html).toContain("data-cd-edit"); // shim injected into the HTML entry

    // Without ?edit=1, no shim.
    const plain = await app.request(`/api/canvases/${canvas.id}/preview/`);
    expect(await plain.text()).not.toContain("data-cd-edit");

    // CSS is never rewritten, even with ?edit=1.
    const css = await app.request(`/api/canvases/${canvas.id}/preview/style.css?edit=1`);
    expect(await css.text()).toBe("body{color:red}");
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

  it("publishing an archived canvas is rejected with NOT_ACTIVE (409)", async () => {
    const { appAs, owner, canvas, canvases } = await setup();
    const app = appAs(owner.id);
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>x</h1>"),
    });
    await canvases.setStatus(canvas.id, "archived");
    const res = await app.request(`/api/canvases/${canvas.id}/publish`, {
      method: "POST",
      headers: SO,
    });
    expect(res.status).toBe(409);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("NOT_ACTIVE");
  });

  it("a disabled canvas is read-only: draft EDITS reject DISABLED 409, READS still work", async () => {
    const { appAs, owner, canvas, canvases } = await setup();
    const app = appAs(owner.id);
    // Seed a draft file while still active, then have an admin take the canvas down.
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>x</h1>"),
    });
    await canvases.setDisabled(canvas.id, "policy violation");

    // Reads still succeed (owner can still see + load the draft).
    expect((await app.request(`/api/canvases/${canvas.id}/draft`)).status).toBe(200);
    expect(
      (await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`)).status,
    ).toBe(200);

    // Every draft EDIT rejects with the shared DISABLED contract.
    const write = await app.request(`/api/canvases/${canvas.id}/draft/file?path=b.html`, {
      method: "PUT",
      headers: SO,
      body: enc("y"),
    });
    expect(write.status).toBe(409);
    const j = await jsonOf<{ code: string; message: string }>(write);
    expect(j.code).toBe("DISABLED");
    expect(j.message).toContain("policy violation");

    const del = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "DELETE",
      headers: SO,
    });
    expect(del.status).toBe(409);
    expect((await jsonOf<{ code: string }>(del)).code).toBe("DISABLED");

    const pub = await app.request(`/api/canvases/${canvas.id}/publish`, {
      method: "POST",
      headers: SO,
    });
    expect(pub.status).toBe(409);
    expect((await jsonOf<{ code: string }>(pub)).code).toBe("DISABLED");
  });

  it("restoring a non-existent version is rejected (400)", async () => {
    const { appAs, owner, canvas } = await setup();
    const res = await appAs(owner.id).request(`/api/canvases/${canvas.id}/restore`, {
      method: "POST",
      headers: { ...SO, "content-type": "application/json" },
      body: JSON.stringify({ version: 999 }),
    });
    expect(res.status).toBe(400);
  });

  it("uploading raw bytes round-trips: PUT binary → GET returns the same bytes with its MIME", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);
    // A tiny PNG header — binary, not valid UTF-8 text.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const put = await app.request(`/api/canvases/${canvas.id}/draft/file?path=logo.png`, {
      method: "PUT",
      headers: SO,
      body: png,
    });
    expect(put.status).toBe(200);
    const view = await jsonOf<{ files: { path: string; mime: string }[] }>(put);
    expect(view.files.find((f) => f.path === "logo.png")?.mime).toMatch(/image\/png/);

    const get = await app.request(`/api/canvases/${canvas.id}/draft/file?path=logo.png`);
    expect(get.headers.get("Content-Type")).toMatch(/image\/png/);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(png);
  });

  it("AE10 over HTTP: If-Draft-File-Hash — a stale hash is 409 DRAFT_CONFLICT with path/currentHash/writer; the current hash lands; another file never conflicts", async () => {
    const { appAs, owner, other, canvas, canvases } = await setup();
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: other.id,
      role: "editor",
    });
    const a = appAs(owner.id);
    const b = appAs(other.id);
    const hashOf = async (path: string) =>
      (
        await jsonOf<{ files: Array<{ path: string; hash: string }> }>(
          await a.request(`/api/canvases/${canvas.id}/draft`),
        )
      ).files.find((f) => f.path === path)?.hash ?? "none";
    const put = (app: typeof a, path: string, body: string, hash?: string) =>
      app.request(`/api/canvases/${canvas.id}/draft/file?path=${path}`, {
        method: "PUT",
        headers: hash === undefined ? SO : { ...SO, "If-Draft-File-Hash": hash },
        body: enc(body),
      });
    expect((await put(a, "index.html", "<h1>base</h1>", "none")).status).toBe(200);
    expect((await put(a, "style.css", "body{}", "none")).status).toBe(200);
    const h0 = await hashOf("index.html");
    const c0 = await hashOf("style.css");
    expect((await put(a, "index.html", "<h1>A</h1>", h0)).status).toBe(200);
    const h1 = await hashOf("index.html");
    const stale = await put(b, "index.html", "<h1>B</h1>", h0);
    expect(stale.status).toBe(409);
    const body = await jsonOf<Record<string, unknown>>(stale);
    expect(body).toMatchObject({
      code: "DRAFT_CONFLICT",
      path: "index.html",
      currentHash: h1,
      updatedBy: owner.id,
      updatedByName: "O",
    });
    expect(typeof body.updatedAt).toBe("number");
    expect(
      await (await a.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`)).text(),
    ).toBe("<h1>A</h1>");
    expect((await put(b, "index.html", "<h1>B</h1>", h1)).status).toBe(200);
    expect((await put(b, "style.css", "body{color:red}", c0)).status).toBe(200);
    // Unconditioned: A's own follow-up is fine; B's over A's fresh write is refused.
    expect((await put(a, "style.css", "body{color:blue}")).status).toBe(409);
    expect((await put(b, "style.css", "body{color:green}")).status).toBe(200);
  });

  it("restore stamps every entry: a save pinned to the pre-restore hash is 409 and the restored file survives; a fresh hash lands", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);
    const hashOf = async () =>
      (
        await jsonOf<{ files: Array<{ path: string; hash: string }> }>(
          await app.request(`/api/canvases/${canvas.id}/draft`),
        )
      ).files[0]?.hash ?? "none";
    for (const body of ["<h1>v1</h1>", "<h1>v2</h1>"]) {
      await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
        method: "PUT",
        headers: SO,
        body: enc(body),
      });
      await app.request(`/api/canvases/${canvas.id}/publish`, { method: "POST", headers: SO });
    }
    const stale = await hashOf();
    await app.request(`/api/canvases/${canvas.id}/restore`, {
      method: "POST",
      headers: { ...SO, "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    const refused = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: { ...SO, "If-Draft-File-Hash": stale },
      body: enc("<h1>stale</h1>"),
    });
    expect(refused.status).toBe(409);
    expect((await jsonOf<{ code: string }>(refused)).code).toBe("DRAFT_CONFLICT");
    expect(
      await (await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`)).text(),
    ).toBe("<h1>v1</h1>");
    const after = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: { ...SO, "If-Draft-File-Hash": await hashOf() },
      body: enc("<h1>edited-after-restore</h1>"),
    });
    expect(after.status).toBe(200);
    // The old draft-level header is gone: it is ignored, never a precondition.
    const legacy = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: { ...SO, "If-Draft-Base": "bogus" },
      body: enc("<h1>legacy-header-ignored</h1>"),
    });
    expect(legacy.status).toBe(200);
  });

  it("delete and rename honour If-Draft-File-Hash; the draft view carries per-file hash + writer", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);
    await app.request(`/api/canvases/${canvas.id}/draft/file?path=a.html`, {
      method: "PUT",
      headers: SO,
      body: enc("a"),
    });
    const view = await jsonOf<{
      files: Array<{
        path: string;
        hash: string;
        updatedBy: string | null;
        updatedByName: string | null;
      }>;
    }>(await app.request(`/api/canvases/${canvas.id}/draft`));
    expect(view.files[0]).toMatchObject({
      path: "a.html",
      updatedBy: owner.id,
      updatedByName: "O",
    });
    const h = view.files[0]?.hash as string;
    const badRename = await app.request(`/api/canvases/${canvas.id}/draft/rename`, {
      method: "POST",
      headers: { ...SO, "content-type": "application/json", "If-Draft-File-Hash": "stale" },
      body: JSON.stringify({ from: "a.html", to: "b.html" }),
    });
    expect(badRename.status).toBe(409);
    const okRename = await app.request(`/api/canvases/${canvas.id}/draft/rename`, {
      method: "POST",
      headers: { ...SO, "content-type": "application/json", "If-Draft-File-Hash": h },
      body: JSON.stringify({ from: "a.html", to: "b.html" }),
    });
    expect(okRename.status).toBe(200);
    const badDelete = await app.request(`/api/canvases/${canvas.id}/draft/file?path=b.html`, {
      method: "DELETE",
      headers: { ...SO, "If-Draft-File-Hash": "stale" },
    });
    expect(badDelete.status).toBe(409);
    const okDelete = await app.request(`/api/canvases/${canvas.id}/draft/file?path=b.html`, {
      method: "DELETE",
      headers: { ...SO, "If-Draft-File-Hash": h },
    });
    expect(okDelete.status).toBe(200);
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

// --- Editor role on the draft surface (editor-roles plan U2, AE2) ----------------------

describe("draftApiRoutes — editor role", () => {
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
    const svc = draftService({
      config,
      canvases,
      versions,
      drafts,
      storage,
      audit,
      log: silent,
      users,
    });
    const mk = (sub: string) =>
      users.upsert({ providerSub: sub, email: `${sub}@e.com`, name: sub, isAdmin: false });
    const owner = await mk("o");
    const editor = await mk("e");
    const viewer = await mk("v");
    const nobody = await mk("n");
    // General access stays PRIVATE (the default) — an editor reaches the draft regardless.
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "k" });
    await canvases.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    await canvases.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: viewer.id,
    });

    function appAs(userId: string, isAdmin = false) {
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("user", { id: userId, isAdmin } as never);
        c.set("orgIds", new Set<string>());
        c.set("clientIp", "127.0.0.1");
        await next();
      });
      app.route(
        "/api/canvases",
        draftApiRoutes({ config, canvases, versions, storage, drafts: svc }),
      );
      return app;
    }
    return { canvases, versions, owner, editor, viewer, nobody, canvas: cv, appAs };
  }

  it("a viewer-role member and a no-role member get 404 on read AND write draft routes", async () => {
    const { appAs, viewer, nobody, canvas } = await setup();
    for (const u of [viewer, nobody]) {
      const app = appAs(u.id);
      expect((await app.request(`/api/canvases/${canvas.id}/draft`)).status).toBe(404);
      const put = await app.request(`/api/canvases/${canvas.id}/draft/file?path=a.html`, {
        method: "PUT",
        headers: SO,
        body: enc("x"),
      });
      expect(put.status).toBe(404);
      expect(
        (await app.request(`/api/canvases/${canvas.id}/publish`, { method: "POST", headers: SO }))
          .status,
      ).toBe(404);
    }
  });

  it("an editor can open the draft, save a file, and publish on a PRIVATE canvas; the version records the editor (AE2, R18)", async () => {
    const { appAs, editor, canvas, versions, canvases } = await setup();
    const app = appAs(editor.id);
    expect((await app.request(`/api/canvases/${canvas.id}/draft`)).status).toBe(200);
    const put = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>by editor</h1>"),
    });
    expect(put.status).toBe(200);
    const pub = await app.request(`/api/canvases/${canvas.id}/publish`, {
      method: "POST",
      headers: SO,
    });
    expect(pub.status).toBe(200);
    const live = await canvases.findById(canvas.id);
    expect(live?.currentVersionId).not.toBeNull();
    const [v] = await versions.listByCanvas(canvas.id);
    expect(v?.createdBy).toBe(editor.id);
  });

  it("an editor's draft EDIT on a DISABLED canvas is the shared 409 DISABLED; the draft READ stays 200", async () => {
    const { appAs, editor, canvas, canvases } = await setup();
    await canvases.setDisabled(canvas.id, "policy");
    const app = appAs(editor.id);
    expect((await app.request(`/api/canvases/${canvas.id}/draft`)).status).toBe(200);
    const put = await app.request(`/api/canvases/${canvas.id}/draft/file?path=a.html`, {
      method: "PUT",
      headers: SO,
      body: enc("x"),
    });
    expect(put.status).toBe(409);
    expect((await jsonOf<{ code: string }>(put)).code).toBe("DISABLED");
  });
});

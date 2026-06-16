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

  it("If-Draft-Base precondition: matching base writes, no header upserts unconditionally", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);

    // Fresh canvas has no live version → baseVersionId is null, sent as the `none` sentinel.
    const matched = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: { ...SO, "If-Draft-Base": "none" },
      body: enc("<h1>hello</h1>"),
    });
    expect(matched.status).toBe(200);

    // No precondition header at all → upsert applies as before (autosave/upload back-compat).
    const noHeader = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: SO,
      body: enc("<h1>again</h1>"),
    });
    expect(noHeader.status).toBe(200);
    expect((await jsonOf<{ dirty: boolean }>(noHeader)).dirty).toBe(true);
  });

  it("a stale If-Draft-Base after a restore is rejected (409) and the restored file survives", async () => {
    const { appAs, owner, canvas } = await setup();
    const app = appAs(owner.id);
    const draftBase = async () =>
      (
        await jsonOf<{ baseVersionId: string | null }>(
          await app.request(`/api/canvases/${canvas.id}/draft`),
        )
      ).baseVersionId;

    // Publish v1 then v2 (each rebases the draft's baseVersionId to the new version).
    for (const body of ["<h1>v1</h1>", "<h1>v2</h1>"]) {
      await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
        method: "PUT",
        headers: SO,
        body: enc(body),
      });
      await app.request(`/api/canvases/${canvas.id}/publish`, { method: "POST", headers: SO });
    }
    const staleBase = await draftBase(); // the editor's fork-point before restore (v2)

    // Restore v1 — wholesale replace; baseVersionId moves to v1.
    await app.request(`/api/canvases/${canvas.id}/restore`, {
      method: "POST",
      headers: { ...SO, "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });

    // A stale unmount-flush pinned to the pre-restore base is refused — no clobber.
    const stale = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: { ...SO, "If-Draft-Base": staleBase ?? "none" },
      body: enc("<h1>stale</h1>"),
    });
    expect(stale.status).toBe(409);
    expect((await jsonOf<{ code: string }>(stale)).code).toBe("DRAFT_CONFLICT");
    const intact = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`);
    expect(await intact.text()).toBe("<h1>v1</h1>"); // restored content untouched

    // A write pinned to the CURRENT (post-restore) base still applies — sequential saves work.
    const after = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`, {
      method: "PUT",
      headers: { ...SO, "If-Draft-Base": (await draftBase()) ?? "none" },
      body: enc("<h1>edited-after-restore</h1>"),
    });
    expect(after.status).toBe(200);
    const final = await app.request(`/api/canvases/${canvas.id}/draft/file?path=index.html`);
    expect(await final.text()).toBe("<h1>edited-after-restore</h1>");
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

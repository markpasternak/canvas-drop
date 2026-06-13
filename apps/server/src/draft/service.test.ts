import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import { canvasBlobPrefix } from "../canvas/storage-keys.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import type { DeployEntry } from "../deploy/ingest.js";
import { memStorage } from "../storage/mem.js";
import { draftService } from "./service.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const silent = pino({ level: "silent" });
const enc = (s: string) => new TextEncoder().encode(s);

async function* folder(files: Record<string, string>): AsyncGenerator<DeployEntry> {
  for (const [path, body] of Object.entries(files)) yield { path, bytes: enc(body) };
}

describe.each(DIALECTS)("draftService (%s)", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function setup() {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const audit = createAuditLog(auditRepository(client), silent);
    const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
    const svc = draftService({ config, canvases, versions, drafts, storage, audit, log: silent });
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "k" });
    const reload = async () => (await canvases.findById(cv.id)) as Canvas;
    return { storage, canvases, versions, drafts, engine, svc, owner, canvas: cv, reload };
  }

  it("getOrCreate derives the draft from the live version, or empty for a new canvas (R10)", async () => {
    const { svc, canvas } = await setup();
    // New canvas → empty draft.
    const empty = await svc.getOrCreate(canvas);
    expect(empty.manifest).toEqual({});
    expect(empty.baseVersionId).toBeNull();

    // Publish a version via deploy, then a fresh canvas's draft mirrors it.
    const { svc: svc2, engine: e2, canvas: c2, owner: o2, reload: reload2 } = await setup();
    await e2.deploy(c2, "folder", folder({ "index.html": "<h1>v1</h1>", "app.js": "1" }), o2.id);
    const live = await reload2();
    const draft = await svc2.getOrCreate(live);
    expect(Object.keys(draft.manifest as object).sort()).toEqual(["app.js", "index.html"]);
    expect(draft.baseVersionId).toBe(live.currentVersionId);
  });

  it("editing the draft creates no version and leaves the live URL on the prior version (AE2)", async () => {
    const { svc, engine, versions, canvas, owner, reload } = await setup();
    await engine.deploy(canvas, "folder", folder({ "index.html": "<h1>v1</h1>" }), owner.id);
    const beforeVersionId = (await reload()).currentVersionId;

    const live = await reload();
    await svc.writeFile(live, "index.html", enc("<h1>edited</h1>"));
    await svc.writeFile(live, "extra.css", enc("body{}"));

    expect((await reload()).currentVersionId).toBe(beforeVersionId); // pointer unchanged
    expect((await versions.listByCanvas(canvas.id)).length).toBe(1); // no new version
  });

  it("editing one of twenty draft files writes exactly one new blob (AE1)", async () => {
    const { svc, engine, storage, canvas, owner, reload } = await setup();
    const base: Record<string, string> = {};
    for (let i = 0; i < 20; i++) base[`f${i}.html`] = `<h1>${i}</h1>`;
    await engine.deploy(canvas, "folder", folder(base), owner.id);
    const live = await reload();
    await svc.getOrCreate(live); // draft mirrors the 20 blobs (already on disk)
    const before = (await storage.list(canvasBlobPrefix(canvas.id))).length;

    await svc.writeFile(live, "f7.html", enc("<h1>7 edited</h1>"));
    const after = (await storage.list(canvasBlobPrefix(canvas.id))).length;
    expect(after).toBe(before + 1);
  });

  it("publish freezes the draft into a new version and swaps the live pointer (AE2/AE3)", async () => {
    const { svc, engine, versions, canvas, owner, reload } = await setup();
    await engine.deploy(canvas, "folder", folder({ "index.html": "<h1>v1</h1>" }), owner.id);
    const live = await reload();
    await svc.writeFile(live, "index.html", enc("<h1>v2 draft</h1>"));

    const result = await svc.publish(await reload(), owner.id);
    expect(result.version).toBe(2);
    const after = await reload();
    expect(after.currentVersionId).toBe(result.versionId);
    const v2 = await versions.findById(result.versionId);
    expect(v2?.status).toBe("ready");
    expect(v2?.source).toBe("editor");
  });

  it("restore an old version into the draft, then publish → new version from old content; old stays immutable (AE3)", async () => {
    const { svc, engine, versions, canvas, owner, reload } = await setup();
    await engine.deploy(canvas, "folder", folder({ "index.html": "<h1>v1</h1>" }), owner.id);
    await engine.deploy(canvas, "folder", folder({ "index.html": "<h1>v2</h1>" }), owner.id);
    const v1 = await versions.findReadyByNumber(canvas.id, 1);

    await svc.restore(await reload(), 1); // draft now = v1's content
    const draft = await svc.getOrCreate(await reload());
    expect(draft.baseVersionId).toBe(v1?.id);

    const result = await svc.publish(await reload(), owner.id);
    expect(result.version).toBe(3); // appended, not overwriting
    // v1 row is untouched and immutable.
    const v1After = await versions.findReadyByNumber(canvas.id, 1);
    expect(v1After?.id).toBe(v1?.id);
    expect((v1After?.manifest as Record<string, { hash: string }>)["index.html"]?.hash).toBe(
      (v1?.manifest as Record<string, { hash: string }>)["index.html"]?.hash,
    );
  });

  it("a direct deploy under a held draft keeps the draft but flags it stale (AE5/F3)", async () => {
    const { svc, engine, drafts, canvas, owner, reload } = await setup();
    await engine.deploy(canvas, "folder", folder({ "index.html": "<h1>v1</h1>" }), owner.id);
    await svc.writeFile(await reload(), "index.html", enc("<h1>my draft</h1>"));
    // An agent/upload publishes directly.
    await engine.deploy(
      await reload(),
      "api",
      folder({ "index.html": "<h1>agent v2</h1>" }),
      owner.id,
    );

    const draft = await drafts.getByCanvas(canvas.id);
    expect(draft?.stale).toBe(true);
    expect((draft?.manifest as Record<string, unknown>)["index.html"]).toBeDefined(); // draft intact
  });

  it("publishing an empty draft is rejected (EMPTY_DEPLOY)", async () => {
    const { svc, canvas } = await setup();
    await expect(svc.publish(canvas, "actor")).rejects.toMatchObject({ code: "EMPTY_DEPLOY" });
  });

  it("restoring a non-existent version throws INVALID_PATH", async () => {
    const { svc, canvas } = await setup();
    await expect(svc.restore(canvas, 999)).rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it("getOrCreate returns the existing draft when one already exists (insert-or-get)", async () => {
    const { svc, drafts, canvas } = await setup();
    const first = await svc.getOrCreate(canvas);
    const second = await svc.getOrCreate(canvas);
    expect(second.id).toBe(first.id);
    expect((await drafts.getByCanvas(canvas.id))?.id).toBe(first.id);
  });

  it("rejects a traversal path and an oversize file on draft write", async () => {
    const { svc, canvas } = await setup();
    await expect(svc.writeFile(canvas, "../escape.txt", enc("x"))).rejects.toMatchObject({
      code: "ZIP_SLIP_REJECTED",
    });
    await expect(
      svc.writeFile(canvas, "big.bin", new Uint8Array(26 * 1024 * 1024)),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});

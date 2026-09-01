import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas, Manifest } from "@canvas-drop/shared/db";
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
import { DraftConflictError } from "../deploy/errors.js";
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
    expect(
      ((v1After?.manifest ?? {}) as Record<string, { hash: string }>)["index.html"]?.hash,
    ).toBe(((v1?.manifest ?? {}) as Record<string, { hash: string }>)["index.html"]?.hash);
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
    expect(((draft?.manifest ?? {}) as Record<string, unknown>)["index.html"]).toBeDefined(); // draft intact
  });

  it("a direct deploy with no draft seeds an in-sync draft (matches production)", async () => {
    const { engine, drafts, canvas, owner, reload } = await setup();
    await engine.deploy(canvas, "api", folder({ "index.html": "<h1>via api</h1>" }), owner.id);

    const live = await reload();
    const draft = await drafts.getByCanvas(canvas.id);
    expect(draft).not.toBeNull();
    expect(Object.keys(draft?.manifest as object)).toEqual(["index.html"]);
    // In step with the just-published version: not stale, base = the live version.
    expect(draft?.stale).toBe(false);
    expect(draft?.baseVersionId).toBe(live.currentVersionId);
  });

  it("a direct deploy under an empty existing draft syncs it (no stale, not behind)", async () => {
    const { svc, engine, drafts, canvas, owner, reload } = await setup();
    // An empty draft exists first (e.g. the editor was opened before any deploy).
    const before = await svc.getOrCreate(canvas);
    expect(before.manifest).toEqual({});
    await engine.deploy(canvas, "api", folder({ "index.html": "<h1>via api</h1>" }), owner.id);

    const live = await reload();
    const draft = await drafts.getByCanvas(canvas.id);
    expect(Object.keys(draft?.manifest as object)).toEqual(["index.html"]);
    expect(draft?.stale).toBe(false);
    expect(draft?.baseVersionId).toBe(live.currentVersionId);
  });

  it("publishing an empty draft is rejected (EMPTY_DEPLOY)", async () => {
    const { svc, canvas } = await setup();
    await expect(svc.publish(canvas, "actor")).rejects.toMatchObject({ code: "EMPTY_DEPLOY" });
  });

  it("restoring a non-existent version throws VERSION_UNAVAILABLE (404, not 400)", async () => {
    const { svc, canvas } = await setup();
    // A missing/pruned version is a not-found, mapped to 404 by the route — matching
    // the management rollback route — rather than INVALID_PATH's 400 (server-canvas-7).
    await expect(svc.restore(canvas, 999)).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
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

  it("a create (mustNotExist) refuses an existing path instead of truncating it", async () => {
    const { svc, canvas, reload } = await setup();
    await svc.writeFile(canvas, "index.html", enc("<h1>real content</h1>"));

    // "Add a file" at an existing path must fail, not overwrite the file with "".
    await expect(
      svc.writeFile(await reload(), "index.html", enc(""), { mustNotExist: true }),
    ).rejects.toMatchObject({ code: "PATH_EXISTS" });

    // The original content is untouched.
    const bytes = await svc.readFile(await reload(), "index.html");
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe("<h1>real content</h1>");

    // The same path normalizes, so a "./index.html" create is rejected too.
    await expect(
      svc.writeFile(await reload(), "./index.html", enc(""), { mustNotExist: true }),
    ).rejects.toMatchObject({ code: "PATH_EXISTS" });

    // A plain write (no mustNotExist) is still an upsert.
    await svc.writeFile(await reload(), "index.html", enc("<h1>edited</h1>"));
    const edited = await svc.readFile(await reload(), "index.html");
    expect(new TextDecoder().decode(edited ?? new Uint8Array())).toBe("<h1>edited</h1>");
  });

  it("rename onto a different existing file is refused (PATH_EXISTS); both files survive", async () => {
    const { svc, canvas, reload } = await setup();
    await svc.writeFile(canvas, "a.html", enc("AAA"));
    await svc.writeFile(await reload(), "b.html", enc("BBB"));

    await expect(svc.renameFile(await reload(), "a.html", "b.html")).rejects.toMatchObject({
      code: "PATH_EXISTS",
    });

    // Neither the source nor the destination was destroyed.
    expect(
      new TextDecoder().decode((await svc.readFile(await reload(), "a.html")) ?? new Uint8Array()),
    ).toBe("AAA");
    expect(
      new TextDecoder().decode((await svc.readFile(await reload(), "b.html")) ?? new Uint8Array()),
    ).toBe("BBB");
  });

  it("rename to a free path moves the file; rename to itself is a no-op", async () => {
    const { svc, canvas, reload } = await setup();
    await svc.writeFile(canvas, "old.html", enc("X"));

    const moved = await svc.renameFile(await reload(), "old.html", "new.html");
    expect(Object.keys(moved.manifest as object)).toEqual(["new.html"]);

    // Renaming a path to itself (after normalization) changes nothing and doesn't throw.
    const same = await svc.renameFile(await reload(), "new.html", "./new.html");
    expect(Object.keys(same.manifest as object)).toEqual(["new.html"]);
  });

  it("deleteFile + renameFile normalize the source path (./prefix resolves; server-canvas-3)", async () => {
    const { svc, canvas, reload } = await setup();
    await svc.writeFile(canvas, "index.html", enc("<h1>home</h1>"));
    await svc.writeFile(await reload(), "keep.html", enc("<h1>keep</h1>"));

    // A relative-style source must resolve to the real (normalized) manifest key
    // rather than spuriously 404 — agents pass './foo' conventionally.
    const renamed = await svc.renameFile(await reload(), "./keep.html", "moved.html");
    expect(Object.keys(renamed.manifest as object).sort()).toEqual(["index.html", "moved.html"]);

    const deleted = await svc.deleteFile(await reload(), "./index.html");
    expect(Object.keys(deleted.manifest as object)).toEqual(["moved.html"]);
  });

  it("warns (does not block) when a draft text file looks like it embeds an API key (server-canvas-11)", async () => {
    const client2 = await makeTestDb("sqlite");
    try {
      const storage = memStorage();
      const users = usersRepository(client2);
      const canvases = canvasesRepository(client2);
      const versions = versionsRepository(client2);
      const drafts = draftsRepository(client2);
      const audit = createAuditLog(auditRepository(client2), silent);
      const warnings: unknown[] = [];
      const log = {
        ...silent,
        warn: (obj: unknown) => warnings.push(obj),
      } as unknown as typeof silent;
      const svc = draftService({ config, canvases, versions, drafts, storage, audit, log });
      const owner = await users.upsert({
        providerSub: "k",
        email: "k@e.com",
        name: "K",
        isAdmin: false,
      });
      const cv = (await canvases.create({
        ownerId: owner.id,
        slug: "kk",
        apiKeyHash: "k",
      })) as Canvas;
      // A key-shaped string in an editor-written .js file warns but still writes.
      const draft = await svc.writeFile(
        cv,
        "config.js",
        // `cd_` + 40+ base64url chars matches the §12.1.2 key-shaped lint.
        enc('const k = "cd_0123456789abcdefABCDEF0123456789abcdefABCDEF";'),
      );
      expect((draft.manifest as Record<string, unknown>)["config.js"]).toBeDefined();
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      await client2.close();
    }
  });
  it("review #4: two writers on DIFFERENT paths never lose each other — the second write merges under CAS", async () => {
    const { svc, drafts, canvas, owner } = await setup();
    await svc.writeFile(canvas, "index.html", enc("<h1>base</h1>"), { actor: owner.id });
    // Simulate the race: B's manifest write lands between A's read and A's write by
    // hijacking A's first CAS attempt.
    const original = drafts.setManifest.bind(drafts);
    let raced = false;
    drafts.setManifest = async (canvasId, manifest, expected) => {
      if (!raced && manifest["a.css"]) {
        raced = true;
        // B saves b.js first (unconditional relative to A: B read the same base).
        const current = (await drafts.getByCanvas(canvasId)) as NonNullable<
          Awaited<ReturnType<typeof drafts.getByCanvas>>
        >;
        await original(
          canvasId,
          {
            ...(current.manifest as Manifest),
            "b.js": { size: 1, hash: "b".repeat(64), mime: "text/javascript" },
          },
          current.updatedAt,
        );
      }
      return original(canvasId, manifest, expected);
    };
    const after = await svc.writeFile(canvas, "a.css", enc("body{}"), { actor: owner.id });
    const paths = Object.keys(after.manifest as Manifest).sort();
    // Both entries survive: A's first attempt missed the CAS and re-merged over B's write.
    expect(paths).toEqual(["a.css", "b.js", "index.html"]);
    expect(raced).toBe(true);
  });

  it("review #4: a same-path race still refuses with DRAFT_CONFLICT after the CAS retry (no silent overwrite)", async () => {
    const { svc, drafts, canvas, owner } = await setup();
    const other = "other-user";
    await svc.writeFile(canvas, "index.html", enc("<h1>base</h1>"), { actor: owner.id });
    const base = await svc.getOrCreate(canvas);
    const baseHash = (base.manifest as Manifest)["index.html"]?.hash as string;
    const original = drafts.setManifest.bind(drafts);
    let raced = false;
    drafts.setManifest = async (canvasId, manifest, expected) => {
      if (!raced) {
        raced = true;
        const current = (await drafts.getByCanvas(canvasId)) as NonNullable<
          Awaited<ReturnType<typeof drafts.getByCanvas>>
        >;
        await original(
          canvasId,
          {
            ...(current.manifest as Manifest),
            "index.html": {
              size: 2,
              hash: "c".repeat(64),
              mime: "text/html",
              updatedBy: other,
              updatedAt: Date.now(),
            },
          },
          current.updatedAt,
        );
      }
      return original(canvasId, manifest, expected);
    };
    await expect(
      svc.writeFile(canvas, "index.html", enc("<h1>mine</h1>"), {
        actor: owner.id,
        expectedHash: baseHash,
      }),
    ).rejects.toBeInstanceOf(DraftConflictError);
    // The other writer's entry is intact.
    const now = await svc.getOrCreate(canvas);
    expect((now.manifest as Manifest)["index.html"]?.hash).toBe("c".repeat(64));
  });
});

const enabledConfig: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_SCREENSHOTS: "on",
});

describe.each(DIALECTS)("draftService.publish — screenshot enqueue (%s)", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** Build a draftService with a spy enqueue and a non-empty draft ready to publish. */
  async function setup(
    cfg: Config,
    enqueue?: (canvas: { id: string; previewMode: string }, v: string) => Promise<void>,
  ) {
    client = await makeTestDb(dialect);
    const storage = memStorage();
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const audit = createAuditLog(auditRepository(client), silent);
    const engine = deployEngine({ config: cfg, canvases, versions, drafts, storage, log: silent });
    const svc = draftService({
      config: cfg,
      canvases,
      versions,
      drafts,
      storage,
      audit,
      log: silent,
      screenshots: enqueue ? { enqueue } : undefined,
    });
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "k" });
    // Deploy v1 so the draft is non-empty and publish() can snapshot it into v2.
    await engine.deploy(cv, "folder", folder({ "index.html": "<h1>v1</h1>" }), owner.id);
    const live = (await canvases.findById(cv.id)) as Canvas;
    return { svc, canvas: live, owner };
  }

  it("publishing calls the screenshot trigger with the new version", async () => {
    // The effective-enabled GATE lives in the trigger (U12), not here — see
    // trigger.test.ts. draftService always calls the injected trigger; the trigger
    // decides whether to actually enqueue.
    const calls: Array<[string, string]> = [];
    const { svc, canvas, owner } = await setup(enabledConfig, async (c, v) => {
      calls.push([c.id, v]);
    });
    const result = await svc.publish(canvas, owner.id);
    expect(calls).toEqual([[canvas.id, result.versionId]]);
  });

  it("a failing enqueue never fails the publish (defensive best-effort)", async () => {
    const { svc, canvas, owner } = await setup(enabledConfig, async () => {
      throw new Error("enqueue boom");
    });
    const result = await svc.publish(canvas, owner.id);
    expect(result.versionId).toBeTruthy();
  });
});

// --- Per-file stale-save protection (editor-roles plan U10, KTD8/R17/AE10) ------------------

describe.each(DIALECTS)("draftService — per-file preconditions (%s)", (dialect) => {
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
    const a = await users.upsert({
      providerSub: "a",
      email: "a@e.com",
      name: "Ada",
      isAdmin: false,
    });
    const b = await users.upsert({
      providerSub: "b",
      email: "b@e.com",
      name: "Bob",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: a.id, slug: "s", apiKeyHash: "k" });
    const hashOf = async (path: string) => {
      const d = await drafts.getByCanvas(cv.id);
      return ((d ? d.manifest : {}) as Manifest)[path]?.hash ?? "none";
    };
    return { svc, drafts, versions, a, b, canvas: cv, hashOf };
  }

  it("characterization: a write without options still upserts; legacy unstamped entries never conflict", async () => {
    const { svc, drafts, canvas } = await setup();
    await svc.writeFile(canvas, "index.html", enc("v1"));
    await svc.writeFile(canvas, "index.html", enc("v2"));
    const m = (await drafts.getByCanvas(canvas.id))?.manifest as Manifest;
    expect(m["index.html"]?.updatedBy).toBeUndefined();
  });

  it("AE10: B's save with the old hash is refused naming A and the time; with the current hash it lands; a different file never conflicts", async () => {
    const { svc, a, b, canvas, hashOf } = await setup();
    await svc.writeFile(canvas, "index.html", enc("<h1>base</h1>"), { actor: a.id });
    await svc.writeFile(canvas, "style.css", enc("body{}"), { actor: a.id });
    const h0 = await hashOf("index.html");
    const c0 = await hashOf("style.css");
    // A saves again (B still holds h0).
    await svc.writeFile(canvas, "index.html", enc("<h1>A</h1>"), { actor: a.id, expectedHash: h0 });
    const h1 = await hashOf("index.html");
    const err = await svc
      .writeFile(canvas, "index.html", enc("<h1>B</h1>"), { actor: b.id, expectedHash: h0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftConflictError);
    const conflict = (err as DraftConflictError).conflict;
    expect(conflict).toMatchObject({
      path: "index.html",
      currentHash: h1,
      updatedBy: a.id,
      updatedByName: "Ada",
    });
    expect(typeof conflict.updatedAt).toBe("number");
    expect((err as Error).message).toMatch(/changed by Ada at/);
    expect(await hashOf("index.html")).toBe(h1); // A's content survived
    // B reloads and retries with the current hash → lands, stamped as B.
    await svc.writeFile(canvas, "index.html", enc("<h1>B</h1>"), { actor: b.id, expectedHash: h1 });
    expect(await hashOf("index.html")).not.toBe(h1);
    // B's save to a different file with its loaded hash is unaffected.
    await svc.writeFile(canvas, "style.css", enc("body{color:red}"), {
      actor: b.id,
      expectedHash: c0,
    });
  });

  it("new file: `none` succeeds when absent and conflicts when the path exists; delete and rename honour the precondition", async () => {
    const { svc, a, b, canvas, hashOf } = await setup();
    await svc.writeFile(canvas, "new.txt", enc("x"), { actor: a.id, expectedHash: "none" });
    await expect(
      svc.writeFile(canvas, "new.txt", enc("y"), { actor: b.id, expectedHash: "none" }),
    ).rejects.toBeInstanceOf(DraftConflictError);
    const h = await hashOf("new.txt");
    await expect(
      svc.deleteFile(canvas, "new.txt", { actor: b.id, expectedHash: "stale" }),
    ).rejects.toBeInstanceOf(DraftConflictError);
    await expect(
      svc.renameFile(canvas, "new.txt", "moved.txt", { actor: b.id, expectedHash: "stale" }),
    ).rejects.toBeInstanceOf(DraftConflictError);
    await svc.renameFile(canvas, "new.txt", "moved.txt", { actor: b.id, expectedHash: h });
    expect(await hashOf("moved.txt")).toBe(h);
    await svc.deleteFile(canvas, "moved.txt", { actor: b.id, expectedHash: h });
    expect(await hashOf("moved.txt")).toBe("none");
  });

  it("unconditioned writes: OK after the same user's write; refused after a DIFFERENT user's write (the two-editor default); a solo sequence never conflicts", async () => {
    const { svc, a, b, canvas } = await setup();
    await svc.writeFile(canvas, "index.html", enc("1"), { actor: a.id });
    await svc.writeFile(canvas, "index.html", enc("2"), { actor: a.id }); // own → fine
    await expect(
      svc.writeFile(canvas, "index.html", enc("3"), { actor: b.id }),
    ).rejects.toBeInstanceOf(DraftConflictError);
    for (let i = 0; i < 25; i++)
      await svc.writeFile(canvas, "index.html", enc(`solo-${i}`), { actor: a.id });
  });

  it("restore by A stamps every entry, so B's save pinned to the pre-restore hash is refused (replaces If-Draft-Base); publish strips writer stamps", async () => {
    const { svc, versions, a, b, canvas, hashOf } = await setup();
    await svc.writeFile(canvas, "index.html", enc("<h1>v1</h1>"), { actor: a.id });
    await svc.publish(canvas, a.id);
    await svc.writeFile(canvas, "index.html", enc("<h1>v2</h1>"), { actor: a.id });
    await svc.publish(canvas, a.id);
    const stale = await hashOf("index.html"); // B loaded v2's hash
    await svc.restore(canvas, 1, a.id);
    expect(await hashOf("index.html")).not.toBe(stale);
    await expect(
      svc.writeFile(canvas, "index.html", enc("<h1>stale</h1>"), {
        actor: b.id,
        expectedHash: stale,
      }),
    ).rejects.toBeInstanceOf(DraftConflictError);
    const [latest] = await versions.listByCanvas(canvas.id);
    const entry = ((latest ? latest.manifest : {}) as Manifest)["index.html"];
    expect(entry).toBeDefined();
    expect(entry && "updatedBy" in entry).toBe(false);
  });

  it("describe() returns each entry's hash + writer name — the one projection both transports use", async () => {
    const { svc, drafts, a, canvas } = await setup();
    await svc.writeFile(canvas, "index.html", enc("x"), { actor: a.id });
    const draft = (await drafts.getByCanvas(canvas.id)) as NonNullable<
      Awaited<ReturnType<typeof drafts.getByCanvas>>
    >;
    const view = await svc.describe(draft, null);
    expect(view.files).toEqual([
      expect.objectContaining({ path: "index.html", updatedBy: a.id, updatedByName: "Ada" }),
    ]);
    expect(typeof view.files[0]?.hash).toBe("string");
    expect(view.dirty).toBe(true);
  });
});

import { createHash } from "node:crypto";
import { type Config, loadConfig } from "@canvas-drop/shared";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOrgMembershipResolver } from "../auth/org-membership.js";
import { blobKey } from "../canvas/storage-keys.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { uploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { memStorage } from "../storage/mem.js";
import { hashUploadId } from "./handle.js";
import { type ManifestInput, uploadService } from "./service.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const silent = pino({ level: "silent" });
const enc = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => createHash("sha256").update(enc(s)).digest("hex");
const manifestFor = (files: Record<string, string>): ManifestInput[] =>
  Object.entries(files).map(([path, content]) => ({
    path,
    hash: sha(content),
    size: enc(content).byteLength,
  }));

describe.each(DIALECTS)("uploadService (%s)", (dialect) => {
  let client: DbClient;
  let clock = 1_000_000;

  afterEach(async () => {
    await client?.close();
  });

  async function setup() {
    clock = 1_000_000;
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const uploadSessions = uploadSessionsRepository(client);
    const storage = memStorage();
    const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
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
    const canvas = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    const svc = uploadService({
      config,
      canvases,
      users,
      uploadSessions,
      storage,
      engine,
      log: silent,
      now: () => clock,
    });
    return {
      svc,
      users,
      canvases,
      versions,
      storage,
      canvas,
      ownerId: owner.id,
      otherId: other.id,
    };
  }

  async function stageAll(
    svc: ReturnType<typeof uploadService>,
    uploadId: string,
    ownerId: string,
    canvasId: string,
    files: Record<string, string>,
  ) {
    for (const [, content] of Object.entries(files)) {
      await svc.stageBlob(uploadId, ownerId, canvasId, sha(content), enc(content));
    }
  }

  it("begin reports all hashes missing on a fresh canvas, then stage+finalize publishes", async () => {
    const { svc, canvases, versions, storage, canvas, ownerId } = await setup();
    const files = { "index.html": "<h1>x</h1>", "app.js": "console.log(1)" };
    const { uploadId, missingHashes } = await svc.begin(canvas, ownerId, manifestFor(files));
    expect(missingHashes.sort()).toEqual([sha(files["index.html"]), sha(files["app.js"])].sort());

    await stageAll(svc, uploadId, ownerId, canvas.id, files);
    const result = await svc.finalize(uploadId, ownerId, canvas.id);
    expect(result.version).toBe(1);
    expect(result.fileCount).toBe(2);

    const after = await canvases.findById(canvas.id);
    const v = await versions.findById(after?.currentVersionId as string);
    expect(v?.status).toBe("ready");
    expect(v?.source).toBe("upload");
    expect(await storage.get(blobKey(canvas.id, sha(files["index.html"])))).not.toBeNull();
  });

  it("skip-unchanged: a re-begin with already-present blobs reports nothing missing", async () => {
    const { svc, canvas, ownerId } = await setup();
    const files = { "index.html": "same" };
    const first = await svc.begin(canvas, ownerId, manifestFor(files));
    await stageAll(svc, first.uploadId, ownerId, canvas.id, files);
    await svc.finalize(first.uploadId, ownerId, canvas.id);

    const second = await svc.begin(canvas, ownerId, manifestFor(files));
    expect(second.missingHashes).toEqual([]);
    // Finalize with zero newly-staged blobs still produces a correct version 2.
    const r2 = await svc.finalize(second.uploadId, ownerId, canvas.id);
    expect(r2.version).toBe(2);
  });

  it("rejects a non-owner caller (no existence leak)", async () => {
    const { svc, canvas, ownerId, otherId } = await setup();
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor({ "index.html": "a" }));
    await expect(svc.finalize(uploadId, otherId, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_HANDLE_INVALID",
    });
  });

  it("rejects staging a handle against the wrong canvas", async () => {
    const { svc, canvas, ownerId } = await setup();
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor({ "index.html": "a" }));
    await expect(
      svc.stageBlob(uploadId, ownerId, "some-other-canvas", sha("a"), enc("a")),
    ).rejects.toMatchObject({ code: "UPLOAD_HANDLE_INVALID" });
  });

  it("block-after-issue: owner blocked after begin fails finalize", async () => {
    const { svc, users, canvas, ownerId } = await setup();
    const files = { "index.html": "a" };
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor(files));
    await stageAll(svc, uploadId, ownerId, canvas.id, files);
    await users.setBlocked(ownerId, true);
    await expect(svc.finalize(uploadId, ownerId, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_HANDLE_INVALID",
    });
  });

  it("is single-use: a second finalize reports ALREADY_FINALIZED", async () => {
    const { svc, canvas, ownerId } = await setup();
    const files = { "index.html": "a" };
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor(files));
    await stageAll(svc, uploadId, ownerId, canvas.id, files);
    await svc.finalize(uploadId, ownerId, canvas.id);
    await expect(svc.finalize(uploadId, ownerId, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_ALREADY_FINALIZED",
    });
  });

  it("idempotent retry: finalize fails on a missing blob, then succeeds after staging it", async () => {
    const { svc, canvases, canvas, ownerId } = await setup();
    const files = { "index.html": "a", "app.js": "b" };
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor(files));
    // Stage only one of two declared blobs.
    await svc.stageBlob(uploadId, ownerId, canvas.id, sha("a"), enc("a"));
    await expect(svc.finalize(uploadId, ownerId, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_MISSING_BLOB",
    });
    // The handle was NOT consumed — stage the rest and retry.
    await svc.stageBlob(uploadId, ownerId, canvas.id, sha("b"), enc("b"));
    const result = await svc.finalize(uploadId, ownerId, canvas.id);
    expect(result.version).toBe(1);
    const after = await canvases.findById(canvas.id);
    expect(after?.currentVersionId).toBeTruthy();
  });

  it("rejects staging a blob not referenced by the begin-manifest", async () => {
    const { svc, storage, canvas, ownerId } = await setup();
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor({ "index.html": "a" }));
    // Correct hash for its bytes, but never declared at begin — could never
    // finalize, so it must not reach storage.
    await expect(
      svc.stageBlob(uploadId, ownerId, canvas.id, sha("sneaky"), enc("sneaky")),
    ).rejects.toMatchObject({ code: "UPLOAD_UNEXPECTED_BLOB" });
    expect(await storage.get(blobKey(canvas.id, sha("sneaky")))).toBeNull();
  });

  it("rejects a blob whose bytes do not match its declared hash", async () => {
    const { svc, canvas, ownerId } = await setup();
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor({ "index.html": "a" }));
    await expect(
      svc.stageBlob(uploadId, ownerId, canvas.id, sha("a"), enc("tampered")),
    ).rejects.toMatchObject({ code: "BLOB_HASH_MISMATCH" });
  });

  it("rejects an oversized single file at begin (per-file cap)", async () => {
    const { svc, canvas, ownerId } = await setup();
    await expect(
      svc.begin(canvas, ownerId, [{ path: "big.bin", hash: sha("x"), size: 26 * 1024 * 1024 }]),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("rejects a manifest whose declared total exceeds the canvas cap at begin", async () => {
    const { svc, canvas, ownerId } = await setup();
    // 5 files × 25 MB = 125 MB > 100 MB, each within the per-file cap.
    const huge: ManifestInput[] = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.bin`,
      hash: sha(`f${i}`),
      size: 25 * 1024 * 1024,
    }));
    await expect(svc.begin(canvas, ownerId, huge)).rejects.toMatchObject({
      code: "CANVAS_TOO_LARGE",
    });
  });

  it("rejects staged bytes whose length disagrees with the declared size", async () => {
    const { svc, canvas, ownerId } = await setup();
    // Declare size 1 for a hash, then stage bytes of a different length.
    const { uploadId } = await svc.begin(canvas, ownerId, [
      { path: "index.html", hash: sha("aaaa"), size: 1 },
    ]);
    await expect(
      svc.stageBlob(uploadId, ownerId, canvas.id, sha("aaaa"), enc("aaaa")),
    ).rejects.toMatchObject({ code: "BLOB_HASH_MISMATCH" });
  });

  it("expires a session past its TTL", async () => {
    const { svc, canvas, ownerId } = await setup();
    const { uploadId } = await svc.begin(canvas, ownerId, manifestFor({ "index.html": "a" }));
    clock += 16 * 60 * 1000; // past the 15-min TTL
    await expect(svc.finalize(uploadId, ownerId, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_EXPIRED",
    });
  });

  it("rejects a zip-slip path in the begin manifest", async () => {
    const { svc, canvas, ownerId } = await setup();
    await expect(
      svc.begin(canvas, ownerId, [{ path: "../escape.html", hash: sha("a"), size: 1 }]),
    ).rejects.toMatchObject({ code: "ZIP_SLIP_REJECTED" });
  });

  it("no double-publish when commit fails after the handle is consumed (server-canvas-1)", async () => {
    // Build a service whose engine.commitReadyVersion throws on the first call only,
    // simulating a transient DB hiccup right after the handle is marked consumed.
    // markConsumed runs BEFORE commitReadyVersion, so a retry must be refused
    // (UPLOAD_ALREADY_FINALIZED) rather than create a second identical version.
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const uploadSessions = uploadSessionsRepository(client);
    const storage = memStorage();
    const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
    let commitCalls = 0;
    const flakyEngine = {
      ...engine,
      commitReadyVersion: (...args: Parameters<typeof engine.commitReadyVersion>) => {
        commitCalls++;
        if (commitCalls === 1) throw new Error("transient commit failure");
        return engine.commitReadyVersion(...args);
      },
    };
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const canvas = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    const svc = uploadService({
      config,
      canvases,
      users,
      uploadSessions,
      storage,
      engine: flakyEngine,
      log: silent,
      now: () => clock,
    });

    const files = { "index.html": "<h1>once</h1>" };
    const { uploadId } = await svc.begin(canvas, owner.id, manifestFor(files));
    await svc.stageBlob(
      uploadId,
      owner.id,
      canvas.id,
      sha(files["index.html"]),
      enc(files["index.html"]),
    );

    // First finalize: handle marked consumed, then the commit throws.
    await expect(svc.finalize(uploadId, owner.id, canvas.id)).rejects.toThrow(
      "transient commit failure",
    );
    // Retry: the consumed handle is terminal — a fresh begin() is required, so NO
    // second version is created from the same content.
    await expect(svc.finalize(uploadId, owner.id, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_ALREADY_FINALIZED",
    });
    expect(commitCalls).toBe(1); // commit was never re-attempted by a retry
    // No live version was committed (the only commit attempt failed), and the row
    // table never gained a second pending/ready version from a re-claim.
    const after = await canvases.findById(canvas.id);
    expect(after?.currentVersionId ?? null).toBeNull();
  });
});

// --- Editor actor (editor-roles plan U3): sessions bind to the authorizing actor and
//     finalize re-resolves the actor's role on the canvas, live. ----------------------

describe.each(DIALECTS)("uploadService — editor actor [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function setup(tenancyActive = false) {
    client = await makeTestDb(dialect);
    const cfg: Config = tenancyActive
      ? loadConfig({ CANVAS_DROP_AUTH_MODE: "dev", CANVAS_DROP_ORG_NAME: "Acme" })
      : config;
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const uploadSessions = uploadSessionsRepository(client);
    const orgs = orgsRepository(client);
    const orgMembers = orgMembersRepository(client);
    const storage = memStorage();
    const engine = deployEngine({ config: cfg, canvases, versions, drafts, storage, log: silent });
    await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });
    const mk = (sub: string) =>
      users.upsert({ providerSub: sub, email: `${sub}@acme.com`, name: sub, isAdmin: false });
    const owner = await mk("owner");
    const editor = await mk("editor");
    const nobody = await mk("nobody");
    const canvas = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    const grant = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    const svc = uploadService({
      config: cfg,
      canvases,
      users,
      uploadSessions,
      storage,
      engine,
      log: silent,
      orgMembership: makeOrgMembershipResolver(orgs, orgMembers),
    });
    const files = { "index.html": "<h1>by editor</h1>" };
    const stage = async (uploadId: string, actorId: string) => {
      for (const content of Object.values(files)) {
        await svc.stageBlob(uploadId, actorId, canvas.id, sha(content), enc(content));
      }
    };
    return { svc, users, canvases, versions, canvas, owner, editor, nobody, grant, files, stage };
  }

  it("an editor begins, stages, and finalizes; the version records the editor as creator", async () => {
    const { svc, versions, canvas, editor, files, stage } = await setup();
    const { uploadId } = await svc.begin(canvas, editor.id, manifestFor(files));
    await stage(uploadId, editor.id);
    const result = await svc.finalize(uploadId, editor.id, canvas.id);
    expect(result.version).toBe(1);
    const [v] = await versions.listByCanvas(canvas.id);
    expect(v?.createdBy).toBe(editor.id);
  });

  it("a session is bound to the actor who began it: another member cannot stage or finalize it", async () => {
    const { svc, canvas, editor, owner, nobody, files, stage } = await setup();
    const { uploadId } = await svc.begin(canvas, editor.id, manifestFor(files));
    // Even the OWNER cannot use the editor's session handle (actor binding, no leak).
    await expect(svc.finalize(uploadId, owner.id, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_HANDLE_INVALID",
    });
    await expect(
      svc.stageBlob(
        uploadId,
        nobody.id,
        canvas.id,
        sha(files["index.html"]),
        enc(files["index.html"]),
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_HANDLE_INVALID" });
    await stage(uploadId, editor.id);
    await expect(svc.finalize(uploadId, nobody.id, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_HANDLE_INVALID",
    });
  });

  it("a forged session by a no-role member fails at finalize (the role is re-resolved on use)", async () => {
    const { svc, canvas, nobody, files, stage } = await setup();
    // The service-level begin has no gate (the front-ends gate it); finalize must still refuse.
    const { uploadId } = await svc.begin(canvas, nobody.id, manifestFor(files));
    await stage(uploadId, nobody.id);
    await expect(svc.finalize(uploadId, nobody.id, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_HANDLE_INVALID",
    });
  });

  it("block-after-issue for roles: an editor demoted after begin cannot finalize", async () => {
    const { svc, canvases, canvas, editor, grant, files, stage } = await setup();
    const { uploadId } = await svc.begin(canvas, editor.id, manifestFor(files));
    await stage(uploadId, editor.id);
    await canvases.setAllowlistRole(canvas.id, grant.id, "viewer");
    await expect(svc.finalize(uploadId, editor.id, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_HANDLE_INVALID",
    });
  });

  it("KTD2 live org predicate: under active tenancy an editor who left the org cannot finalize", async () => {
    const { svc, users, canvas, editor, files, stage } = await setup(true);
    const { uploadId } = await svc.begin(canvas, editor.id, manifestFor(files));
    await stage(uploadId, editor.id);
    // Re-home the editor's account outside the org's domains → live membership ∅.
    await users.upsert({
      providerSub: "editor",
      email: "editor@gmail.com",
      name: "editor",
      isAdmin: false,
    });
    await expect(svc.finalize(uploadId, editor.id, canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_HANDLE_INVALID",
    });
  });

  it("under active tenancy an in-org editor finalizes (membership resolved live from the email domain)", async () => {
    const { svc, canvas, editor, files, stage } = await setup(true);
    const { uploadId } = await svc.begin(canvas, editor.id, manifestFor(files));
    await stage(uploadId, editor.id);
    expect((await svc.finalize(uploadId, editor.id, canvas.id)).version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Deployment coordination on the staged path (plan 2026-09-12, KTD11 / U3).
// ---------------------------------------------------------------------------
describe.each(DIALECTS)("uploadService — deployment coordination (%s)", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  const R = "gh:acme/roadmap@3f9c2e1:prod";
  const S = "gh:acme/roadmap@77aa01b:prod";

  async function setup() {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const uploadSessions = uploadSessionsRepository(client);
    const storage = memStorage();
    const engine = deployEngine({
      config,
      canvases,
      versions,
      drafts,
      storage,
      log: silent,
      waitOptions: { intervalMs: 5 },
    });
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const canvas = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    const svc = uploadService({
      config,
      canvases,
      users,
      uploadSessions,
      storage,
      engine,
      log: silent,
    });
    /** An unrelated publication landing in between (an editor publish). */
    const publishElsewhere = async () => {
      const v = await versions.createPending({
        canvasId: canvas.id,
        number: await versions.nextNumber(canvas.id),
        createdBy: owner.id,
        source: "editor",
      });
      await versions.markReady(v.id, { fileCount: 1, totalBytes: 1, manifest: {} });
      await canvases.setCurrentVersion(canvas.id, v.id);
      return v;
    };
    const token = async () => (await canvases.findById(canvas.id))?.publicationToken ?? "";
    const session = async (
      files: Record<string, string>,
      coordination?: { releaseId?: string; expectedPublicationToken?: string },
    ) => {
      const begun = await svc.begin(canvas, owner.id, manifestFor(files), coordination);
      expect(begun.alreadyCurrent).toBeUndefined();
      for (const [, content] of Object.entries(files)) {
        await svc.stageBlob(begun.uploadId, owner.id, canvas.id, sha(content), enc(content));
      }
      return begun.uploadId;
    };
    const readyRows = async () =>
      (await versions.listByCanvas(canvas.id)).filter((v) => v.status === "ready");
    return {
      svc,
      canvases,
      versions,
      uploadSessions,
      canvas,
      ownerId: owner.id,
      publishElsewhere,
      token,
      session,
      readyRows,
    };
  }

  it("begin with a release that is already live returns already_current and opens no session", async () => {
    const t = await setup();
    const id = await t.session({ "index.html": "a" }, { releaseId: R });
    const live = await t.svc.finalize(id, t.ownerId, t.canvas.id);
    expect(live.outcome).toBe("published");
    const begun = await t.svc.begin(t.canvas, t.ownerId, manifestFor({ "index.html": "b" }), {
      releaseId: R,
    });
    expect(begun.alreadyCurrent?.outcome).toBe("already_current");
    expect(begun.alreadyCurrent?.versionId).toBe(live.versionId);
    expect(begun.uploadId).toBe("");
    expect(
      await t.uploadSessions.listActiveByCanvas(t.canvas.id, Date.now() + 120_000),
    ).toHaveLength(0);
  });

  it("begin with a stale token is PUBLICATION_CHANGED and opens no session", async () => {
    const t = await setup();
    const stale = await t.token();
    await t.publishElsewhere();
    await expect(
      t.svc.begin(t.canvas, t.ownerId, manifestFor({ "index.html": "a" }), {
        expectedPublicationToken: stale,
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_CHANGED" });
    expect(await t.uploadSessions.listActiveByCanvas(t.canvas.id, Date.now())).toHaveLength(0);
  });

  it("Covers AE12 / F6. a stale token at finalize conflicts BEFORE any claim; the handle stays usable and finalizes with the fresh token", async () => {
    const t = await setup();
    const t1 = await t.token();
    const id = await t.session(
      { "index.html": "mine" },
      { releaseId: R, expectedPublicationToken: t1 },
    );
    const editors = await t.publishElsewhere(); // T2 now
    const before = (await t.versions.listByCanvas(t.canvas.id)).length;
    await expect(t.svc.finalize(id, t.ownerId, t.canvas.id)).rejects.toMatchObject({
      code: "PUBLICATION_CHANGED",
      current: expect.objectContaining({ versionId: editors.id }),
    });
    // Pre-check path: no version number allocated, session neither claimed nor consumed.
    expect(await t.versions.listByCanvas(t.canvas.id)).toHaveLength(before);
    const s = await t.uploadSessions.findByHandleHash(hashUploadId(id));
    expect(s?.consumedAt).toBeNull();
    expect(s?.finalizingAt).toBeNull();
    // Reassessed: finalize again with the token read back now, without re-staging.
    const t2 = await t.token();
    const r = await t.svc.finalize(id, t.ownerId, t.canvas.id, { expectedPublicationToken: t2 });
    expect(r.outcome).toBe("published");
    expect(r.releaseId).toBe(R);
    expect(r.publicationToken).not.toBe(t2);
    expect((await t.versions.findById(r.versionId))?.source).toBe("upload");
    expect((await t.uploadSessions.findByHandleHash(hashUploadId(id)))?.consumedAt).not.toBeNull();
  });

  it("a conflict raised by the atomic activation un-consumes the session so it can finalize again", async () => {
    const t = await setup();
    const t1 = await t.token();
    const id = await t.session({ "index.html": "mine" }, { expectedPublicationToken: t1 });
    // The publication changes between finalize's pre-check and its swap.
    const original = t.canvases.activateVersion.bind(t.canvases);
    const spy = vi
      .spyOn(t.canvases, "activateVersion")
      .mockImplementationOnce(async (cid, vid, opts) => {
        await t.publishElsewhere();
        return original(cid, vid, opts);
      });
    await expect(t.svc.finalize(id, t.ownerId, t.canvas.id)).rejects.toMatchObject({
      code: "PUBLICATION_CHANGED",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const s = await t.uploadSessions.findByHandleHash(hashUploadId(id));
    expect(s?.consumedAt).toBeNull();
    expect(s?.finalizingAt).toBeNull();
    // Our candidate is gone; only the intervening publish is ready.
    expect(await t.readyRows()).toHaveLength(1);
    const t2 = await t.token();
    const r = await t.svc.finalize(id, t.ownerId, t.canvas.id, { expectedPublicationToken: t2 });
    expect(r.outcome).toBe("published");
    expect(await t.readyRows()).toHaveLength(2);
  });

  it("a finalize releaseId that differs from begin's is RELEASE_ID_MISMATCH and touches nothing", async () => {
    const t = await setup();
    const id = await t.session({ "index.html": "a" }, { releaseId: R });
    await expect(
      t.svc.finalize(id, t.ownerId, t.canvas.id, { releaseId: S }),
    ).rejects.toMatchObject({
      code: "RELEASE_ID_MISMATCH",
    });
    expect(await t.readyRows()).toHaveLength(0);
    const s = await t.uploadSessions.findByHandleHash(hashUploadId(id));
    expect(s?.consumedAt).toBeNull();
    // The same release repeated at finalize is fine; a finalize without one inherits it.
    const r = await t.svc.finalize(id, t.ownerId, t.canvas.id, { releaseId: R });
    expect(r.releaseId).toBe(R);
  });

  it("finalize without coordination inherits begin's values (a stale begin token still conflicts)", async () => {
    const t = await setup();
    const t1 = await t.token();
    const id = await t.session({ "index.html": "a" }, { expectedPublicationToken: t1 });
    await t.publishElsewhere();
    await expect(t.svc.finalize(id, t.ownerId, t.canvas.id)).rejects.toMatchObject({
      code: "PUBLICATION_CHANGED",
    });
  });

  it("two sessions for one release finalized in sequence: the second is already_current, one ready version", async () => {
    const t = await setup();
    const a = await t.session({ "index.html": "a" }, { releaseId: R });
    const b = await t.session({ "index.html": "b" }, { releaseId: R });
    const first = await t.svc.finalize(a, t.ownerId, t.canvas.id);
    const second = await t.svc.finalize(b, t.ownerId, t.canvas.id);
    expect(first.outcome).toBe("published");
    expect(second.outcome).toBe("already_current");
    expect(second.versionId).toBe(first.versionId);
    expect(await t.readyRows()).toHaveLength(1);
    // The second handle was never consumed: the pre-check answered it.
    expect((await t.uploadSessions.findByHandleHash(hashUploadId(b)))?.consumedAt).toBeNull();
  });

  it("Covers R17. a repeated finalize of a consumed session whose release is live is already_current; not live is UPLOAD_ALREADY_FINALIZED", async () => {
    const t = await setup();
    const id = await t.session({ "index.html": "a" }, { releaseId: R });
    const live = await t.svc.finalize(id, t.ownerId, t.canvas.id);
    const retry = await t.svc.finalize(id, t.ownerId, t.canvas.id); // the lost-response retry
    expect(retry.outcome).toBe("already_current");
    expect(retry.versionId).toBe(live.versionId);
    expect(await t.readyRows()).toHaveLength(1);
    // Someone moved off this release: the handle is spent, as today.
    await t.publishElsewhere();
    await expect(t.svc.finalize(id, t.ownerId, t.canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_ALREADY_FINALIZED",
    });
    // A session begun without a release keeps today's terminal behavior.
    const bare = await t.session({ "index.html": "bare" });
    await t.svc.finalize(bare, t.ownerId, t.canvas.id);
    await expect(t.svc.finalize(bare, t.ownerId, t.canvas.id)).rejects.toMatchObject({
      code: "UPLOAD_ALREADY_FINALIZED",
    });
  });

  it("a successful finalize carries the additive result fields", async () => {
    const t = await setup();
    const t0 = await t.token();
    const id = await t.session(
      { "index.html": "a" },
      { releaseId: R, expectedPublicationToken: t0 },
    );
    const r = await t.svc.finalize(id, t.ownerId, t.canvas.id);
    expect(r).toMatchObject({ outcome: "published", releaseId: R, version: 1, fileCount: 1 });
    expect(r.publicationToken).toMatch(/^[0-9a-f]{32}$/);
    expect(r.publicationToken).not.toBe(t0);
    expect(r.versionId).toBe((await t.canvases.findById(t.canvas.id))?.currentVersionId);
  });
});

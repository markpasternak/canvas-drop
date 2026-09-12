import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { type Config, loadConfig } from "@canvas-drop/shared";
import { sql } from "drizzle-orm";
import { zipSync } from "fflate";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import { blobKey } from "../canvas/storage-keys.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { uploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { inProcessRateLimitStore } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { uploadService } from "../upload/service.js";
import { deployApiRoutes } from "./deploy-api.js";

const silent = pino({ level: "silent" });
const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const enc = (s: string) => new TextEncoder().encode(s);
async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("deployApiRoutes (Bearer key)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** Create a canvas + its plaintext key; return the wired app and ids. */
  async function setup(dialect: (typeof DIALECTS)[number] = "sqlite") {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const audit = createAuditLog(auditRepository(client), silent);
    const storage = memStorage();
    const engine = deployEngine({
      config,
      canvases,
      versions,
      drafts,
      storage,
      log: silent,
    });
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });

    async function mkCanvas() {
      const key = generateApiKey();
      const cv = await canvases.create({
        ownerId: owner.id,
        slug: `s${Math.random()}`.slice(0, 8),
        apiKeyHash: hashApiKey(key),
      });
      return { id: cv.id, key };
    }

    const upload = uploadService({
      config,
      canvases,
      users,
      uploadSessions: uploadSessionsRepository(client),
      storage,
      engine,
    });
    const app = new Hono<AppEnv>();
    app.route(
      "/v1/canvases",
      deployApiRoutes({ config, canvases, versions, engine, audit, storage, upload }),
    );
    return { app, canvases, versions, storage, mkCanvas, ownerId: owner.id };
  }

  const zip = () => Buffer.from(zipSync({ "index.html": enc("<h1>x</h1>") }));

  it("a key for a disabled canvas is rejected (active-only) — 401", async () => {
    const { app, canvases, mkCanvas } = await setup();
    const a = await mkCanvas();
    await canvases.setStatus(a.id, "disabled");
    const res = await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: zip(),
    });
    expect(res.status).toBe(401);
  });

  it("a key for an archived canvas is rejected (deploys blocked while archived) — 401", async () => {
    const { app, canvases, mkCanvas } = await setup();
    const a = await mkCanvas();
    await canvases.archive(a.id);
    const res = await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: zip(),
    });
    expect(res.status).toBe(401);
  });

  it("GET /:id returns the derived publicationState (draft → published after a deploy)", async () => {
    const { app, mkCanvas } = await setup();
    const a = await mkCanvas();
    const draftRes = await app.request(`/v1/canvases/${a.id}`, {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(draftRes.status).toBe(200);
    const draftBody = (await draftRes.json()) as Record<string, unknown>;
    expect(draftBody.publicationState).toBe("draft");
    // The documented shape (docs/site/api/deploy-api.md, agents/llms.md): audience rides along.
    expect(draftBody.accessMode).toBe("restricted");
    expect(Object.keys(draftBody).sort()).toEqual(
      [
        "accessMode",
        "currentVersion",
        "currentVersionId",
        "id",
        "publicationState",
        "publicationToken",
        "slug",
        "status",
        "title",
        "url",
      ].sort(),
    );

    await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: zip(),
    });
    const pubRes = await app.request(`/v1/canvases/${a.id}`, {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(((await pubRes.json()) as { publicationState: string }).publicationState).toBe(
      "published",
    );
  });

  it.each(DIALECTS)(
    "unpublish via the Bearer API: published → draft; a later deploy clears revokedAt; wrong key → 403 [%s]",
    async (dialect) => {
      const { app, canvases, mkCanvas } = await setup(dialect);
      const a = await mkCanvas();
      const b = await mkCanvas();

      // Draft (never published) → 409.
      const onDraft = await app.request(`/v1/canvases/${a.id}/unpublish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(onDraft.status).toBe(409);
      expect((await jsonOf<{ code: string }>(onDraft)).code).toBe("CANNOT_UNPUBLISH");

      // Publish, then unpublish → draft.
      await app.request(`/v1/canvases/${a.id}/deploy`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${a.key}` },
        body: zip(),
      });
      const ok = await app.request(`/v1/canvases/${a.id}/unpublish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(ok.status).toBe(200);
      const body = await jsonOf<{ publicationState: string; currentVersionId: string | null }>(ok);
      expect(body.publicationState).toBe("draft");
      expect(body.currentVersionId).toBeNull();
      expect((await canvases.findById(a.id))?.revokedAt).toBeNull();

      // Authoring revocation is a stronger lifecycle marker than ordinary unpublish.
      // A later keyed deploy is still a publish path and must clear that marker.
      expect(await canvases.revoke(a.id)).toBeTruthy();
      expect((await canvases.findById(a.id))?.revokedAt).not.toBeNull();

      const republish = await app.request(`/v1/canvases/${a.id}/deploy`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${a.key}` },
        body: zip(),
      });
      expect(republish.status).toBe(200);
      expect((await canvases.findById(a.id))?.revokedAt).toBeNull();

      // A's key cannot unpublish B's canvas.
      const cross = await app.request(`/v1/canvases/${b.id}/unpublish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.key}` },
      });
      expect(cross.status).toBe(403);
    },
  );

  it("rollback to an existing-but-pending version → 404 (only ready versions are targets)", async () => {
    const { app, versions, mkCanvas, ownerId } = await setup();
    const a = await mkCanvas();
    await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: zip(),
    });
    await versions.createPending({ canvasId: a.id, number: 2, createdBy: ownerId, source: "api" });
    const res = await app.request(`/v1/canvases/${a.id}/rollback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.key}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 2 }),
    });
    expect(res.status).toBe(404);
  });

  // --- BEARER-KEY ISOLATION FIRST (execution note) ---
  it("a valid key for canvas A cannot deploy to canvas B", async () => {
    const { app, mkCanvas } = await setup();
    const a = await mkCanvas();
    const b = await mkCanvas();
    const res = await app.request(`/v1/canvases/${b.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` }, // A's key, B's canvas
      body: zip(),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a missing or invalid key with 401", async () => {
    const { app, mkCanvas } = await setup();
    const a = await mkCanvas();
    expect(
      (await app.request(`/v1/canvases/${a.id}/deploy`, { method: "PUT", body: zip() })).status,
    ).toBe(401);
    const bad = await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: "Bearer cd_not_a_real_key" },
      body: zip(),
    });
    expect(bad.status).toBe(401);
  });

  it("deploys with a valid key and returns the machine-readable result", async () => {
    const { app, mkCanvas } = await setup();
    const a = await mkCanvas();
    const res = await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: zip(),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf<{
      url: string;
      version: number;
      fileCount: number;
      warnings: string[];
    }>(res);
    expect(body.version).toBe(1);
    expect(body.fileCount).toBe(1);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("a zip-slip ZIP via the API → ZIP_SLIP_REJECTED, no version", async () => {
    const { app, versions, mkCanvas } = await setup();
    const a = await mkCanvas();
    const evil = Buffer.from(zipSync({ "../escape.txt": enc("x"), "index.html": enc("ok") }));
    const res = await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: evil,
    });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("ZIP_SLIP_REJECTED");
    expect((await versions.listByCanvas(a.id)).every((v) => v.status !== "ready")).toBe(true);
  });

  it("lists deploy history newest-first and rolls back to a prior version", async () => {
    const { app, canvases, mkCanvas } = await setup();
    const a = await mkCanvas();
    const v1 = Buffer.from(zipSync({ "index.html": enc("one") }));
    const v2 = Buffer.from(zipSync({ "index.html": enc("two") }));
    await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: v1,
    });
    await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: v2,
    });

    const hist = await jsonOf<{ versions: Array<{ number: number; current: boolean }> }>(
      await app.request(`/v1/canvases/${a.id}/versions`, {
        headers: { Authorization: `Bearer ${a.key}` },
      }),
    );
    expect(hist.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(hist.versions.find((v) => v.current)?.number).toBe(2);

    // roll back to version 1
    const rb = await app.request(`/v1/canvases/${a.id}/rollback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.key}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(rb.status).toBe(200);
    const cv = await canvases.findById(a.id);
    const v1Row = await versionsRepository(client).findReadyByNumber(a.id, 1);
    expect(cv?.currentVersionId).toBe(v1Row?.id);

    // rolling back to a non-existent version → stable error
    const bad = await app.request(`/v1/canvases/${a.id}/rollback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.key}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 99 }),
    });
    expect(bad.status).toBe(404);

    // a float or non-positive version is a malformed body → 400 (Zod-validated,
    // not a cast that lets 1.5 / -1 / 0 fall through to a misleading 404).
    for (const version of [1.5, -1, 0]) {
      const res = await app.request(`/v1/canvases/${a.id}/rollback`, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.key}`, "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      expect(res.status).toBe(400);
      expect((await jsonOf<{ error: string }>(res)).error).toBe("invalid_body");
    }
  });

  it("GET /files reads back the live version — listing, raw content, and 404s", async () => {
    const { app, mkCanvas } = await setup();
    const a = await mkCanvas();
    const indexHtml = "<h1>live</h1>";

    // No live version yet → 404 NOT_PUBLISHED.
    const empty = await app.request(`/v1/canvases/${a.id}/files`, {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(empty.status).toBe(404);
    expect((await jsonOf<{ code: string }>(empty)).code).toBe("NOT_PUBLISHED");

    await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: Buffer.from(zipSync({ "index.html": enc(indexHtml), "app.js": enc("var x=1") })),
    });

    // Listing (no path) → JSON manifest of the live version.
    const list = await app.request(`/v1/canvases/${a.id}/files`, {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(list.status).toBe(200);
    const listing = await jsonOf<{
      version: number;
      fileCount: number;
      files: { path: string; hash: string }[];
    }>(list);
    expect(listing.version).toBe(1);
    expect(listing.files.map((f) => f.path).sort()).toEqual(["app.js", "index.html"]);

    // ?path → raw bytes, with a content hash that matches what was deployed.
    const file = await app.request(`/v1/canvases/${a.id}/files?path=index.html`, {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("text/html");
    expect(file.headers.get("etag")).toBe(
      `"${createHash("sha256").update(enc(indexHtml)).digest("hex")}"`,
    );
    expect(await file.text()).toBe(indexHtml);

    // Unknown path → 404 NOT_FOUND.
    const miss = await app.request(`/v1/canvases/${a.id}/files?path=nope.txt`, {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(miss.status).toBe(404);

    // A key for a different canvas can't read these files → 403.
    const b = await mkCanvas();
    const cross = await app.request(`/v1/canvases/${a.id}/files`, {
      headers: { Authorization: `Bearer ${b.key}` },
    });
    expect(cross.status).toBe(403);
  });

  it("GET /files?path= returns 404 when the blob is missing from storage", async () => {
    const { app, storage, mkCanvas } = await setup();
    const a = await mkCanvas();
    const indexHtml = "<h1>gone</h1>";
    await app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: Buffer.from(zipSync({ "index.html": enc(indexHtml) })),
    });
    // Simulate storage corruption: drop the blob but keep the manifest entry.
    const hash = createHash("sha256").update(enc(indexHtml)).digest("hex");
    await storage.delete(blobKey(a.id, hash));

    const res = await app.request(`/v1/canvases/${a.id}/files?path=index.html`, {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(res.status).toBe(404);
    // The listing still works — only the byte fetch fails.
    const list = await app.request(`/v1/canvases/${a.id}/files`, {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(list.status).toBe(200);
  });
});

describe("deployApiRoutes — staging upload (plan 003)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  const enc2 = (s: string) => new TextEncoder().encode(s);
  const sha = (s: string) => createHash("sha256").update(enc2(s)).digest("hex");

  async function setup() {
    client = await makeTestDb("sqlite");
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const audit = createAuditLog(auditRepository(client), silent);
    const storage = memStorage();
    const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const upload = uploadService({
      config,
      canvases,
      users,
      uploadSessions: uploadSessionsRepository(client),
      storage,
      engine,
    });
    const app = new Hono<AppEnv>();
    app.route(
      "/v1/canvases",
      deployApiRoutes({ config, canvases, versions, engine, audit, storage, upload }),
    );

    async function mkCanvas() {
      const key = generateApiKey();
      const cv = await canvases.create({
        ownerId: owner.id,
        slug: `s${Math.random()}`.slice(0, 8),
        apiKeyHash: hashApiKey(key),
      });
      return { id: cv.id, key };
    }
    return { app, mkCanvas };
  }

  const h = (key: string) => ({
    Authorization: `Bearer ${key}`,
    "content-type": "application/json",
  });

  it("full flow: begin → PUT each blob → finalize publishes the canvas", async () => {
    const { app, mkCanvas } = await setup();
    const a = await mkCanvas();
    const files = { "index.html": "<h1>x</h1>", "app.js": "console.log(1)" };
    const manifest = Object.entries(files).map(([path, content]) => ({
      path,
      hash: sha(content),
      size: enc2(content).byteLength,
    }));

    const begun = (await (
      await app.request(`/v1/canvases/${a.id}/uploads`, {
        method: "POST",
        headers: h(a.key),
        body: JSON.stringify({ manifest }),
      })
    ).json()) as { uploadId: string; missingHashes: string[] };
    expect(begun.missingHashes).toHaveLength(2);

    for (const [, content] of Object.entries(files)) {
      const res = await app.request(
        `/v1/canvases/${a.id}/uploads/${begun.uploadId}/blobs/${sha(content)}`,
        { method: "PUT", headers: { Authorization: `Bearer ${a.key}` }, body: enc2(content) },
      );
      expect(res.status).toBe(204);
    }

    const fin = await app.request(`/v1/canvases/${a.id}/uploads/${begun.uploadId}/finalize`, {
      method: "POST",
      headers: h(a.key),
    });
    expect(fin.status).toBe(200);
    expect(((await fin.json()) as { version: number }).version).toBe(1);

    const got = await app.request(`/v1/canvases/${a.id}`, {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(((await got.json()) as { publicationState: string }).publicationState).toBe("published");
  });

  it("a handle minted for canvas A is rejected against canvas B (404, no leak)", async () => {
    const { app, mkCanvas } = await setup();
    const a = await mkCanvas();
    const b = await mkCanvas();
    const begun = (await (
      await app.request(`/v1/canvases/${a.id}/uploads`, {
        method: "POST",
        headers: h(a.key),
        body: JSON.stringify({ manifest: [{ path: "index.html", hash: sha("x"), size: 1 }] }),
      })
    ).json()) as { uploadId: string };

    // Present A's handle on B's URL with B's key.
    const res = await app.request(
      `/v1/canvases/${b.id}/uploads/${begun.uploadId}/blobs/${sha("x")}`,
      { method: "PUT", headers: { Authorization: `Bearer ${b.key}` }, body: enc2("x") },
    );
    expect(res.status).toBe(404);
  });

  it("finalize before all blobs are staged → UPLOAD_MISSING_BLOB", async () => {
    const { app, mkCanvas } = await setup();
    const a = await mkCanvas();
    const begun = (await (
      await app.request(`/v1/canvases/${a.id}/uploads`, {
        method: "POST",
        headers: h(a.key),
        body: JSON.stringify({ manifest: [{ path: "index.html", hash: sha("x"), size: 1 }] }),
      })
    ).json()) as { uploadId: string };
    const fin = await app.request(`/v1/canvases/${a.id}/uploads/${begun.uploadId}/finalize`, {
      method: "POST",
      headers: h(a.key),
    });
    expect(fin.status).toBe(400);
    expect(((await fin.json()) as { code: string }).code).toBe("UPLOAD_MISSING_BLOB");
  });

  it("a blob whose bytes don't match the :hash is rejected (BLOB_HASH_MISMATCH)", async () => {
    const { app, mkCanvas } = await setup();
    const a = await mkCanvas();
    const begun = (await (
      await app.request(`/v1/canvases/${a.id}/uploads`, {
        method: "POST",
        headers: h(a.key),
        body: JSON.stringify({ manifest: [{ path: "index.html", hash: sha("x"), size: 1 }] }),
      })
    ).json()) as { uploadId: string };
    const res = await app.request(
      `/v1/canvases/${a.id}/uploads/${begun.uploadId}/blobs/${sha("x")}`,
      { method: "PUT", headers: { Authorization: `Bearer ${a.key}` }, body: enc2("tampered") },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("BLOB_HASH_MISMATCH");
  });

  it("a second finalize of the same handle maps to 409 UPLOAD_ALREADY_FINALIZED", async () => {
    const { app, mkCanvas } = await setup();
    const a = await mkCanvas();
    const content = "<h1>x</h1>";
    const begun = (await (
      await app.request(`/v1/canvases/${a.id}/uploads`, {
        method: "POST",
        headers: h(a.key),
        body: JSON.stringify({
          manifest: [{ path: "index.html", hash: sha(content), size: enc2(content).byteLength }],
        }),
      })
    ).json()) as { uploadId: string };
    await app.request(`/v1/canvases/${a.id}/uploads/${begun.uploadId}/blobs/${sha(content)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.key}` },
      body: enc2(content),
    });
    const first = await app.request(`/v1/canvases/${a.id}/uploads/${begun.uploadId}/finalize`, {
      method: "POST",
      headers: h(a.key),
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/v1/canvases/${a.id}/uploads/${begun.uploadId}/finalize`, {
      method: "POST",
      headers: h(a.key),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("UPLOAD_ALREADY_FINALIZED");
  });
});

// ---------------------------------------------------------------------------
// Deployment coordination on the keyed HTTP surface (plan 2026-09-12, U4).
// ---------------------------------------------------------------------------
describe.each(DIALECTS)("deployApiRoutes — deployment coordination [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  const R = "gh:acme/roadmap@3f9c2e1:prod";
  const S = "gh:acme/roadmap@77aa01b:prod";
  const HEX32 = /^[0-9a-f]{32}$/;
  const enc3 = (s: string) => new TextEncoder().encode(s);
  const sha3 = (s: string) => createHash("sha256").update(enc3(s)).digest("hex");
  const zipOf = (files: Record<string, string>) =>
    Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p, b]) => [p, enc3(b)]))));

  async function setup(opts: { deployPerMin?: number } = {}) {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const auditRepo = auditRepository(client);
    const audit = createAuditLog(auditRepo, silent);
    const storage = memStorage();
    const uploadSessions = uploadSessionsRepository(client);
    // Wired like production: the engine's blob GC must see staged sessions.
    const engine = deployEngine({
      config,
      canvases,
      versions,
      drafts,
      storage,
      log: silent,
      uploadSessions,
      waitOptions: { intervalMs: 5 },
    });
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const upload = uploadService({ config, canvases, users, uploadSessions, storage, engine });
    const cfg = opts.deployPerMin
      ? loadConfig({
          CANVAS_DROP_AUTH_MODE: "dev",
          CANVAS_DROP_RATELIMIT_DEPLOY_PER_MIN: String(opts.deployPerMin),
        })
      : config;
    const app = new Hono<AppEnv>();
    app.route(
      "/v1/canvases",
      deployApiRoutes({
        config: cfg,
        canvases,
        versions,
        engine,
        audit,
        storage,
        upload,
        rateLimitStore: opts.deployPerMin ? inProcessRateLimitStore() : undefined,
      }),
    );
    async function mkCanvas() {
      const key = generateApiKey();
      const cv = await canvases.create({
        ownerId: owner.id,
        slug: `s${Math.random()}`.slice(0, 8),
        apiKeyHash: hashApiKey(key),
      });
      return { id: cv.id, key, token: cv.publicationToken };
    }
    const get = async (id: string, key: string) => {
      const res = await app.request(`/v1/canvases/${id}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const put = async (
      id: string,
      key: string,
      files: Record<string, string>,
      query: Record<string, string> = {},
    ) => {
      const qs = new URLSearchParams(query).toString();
      const res = await app.request(`/v1/canvases/${id}/deploy${qs ? `?${qs}` : ""}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${key}` },
        body: zipOf(files),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const json = async (method: string, path: string, key: string, body?: unknown) => {
      const res = await app.request(`/v1/canvases${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body:
          body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: (text ? JSON.parse(text) : null) as Record<string, unknown>,
      };
    };
    const deployAudits = async () => {
      await audit.flush();
      return (await auditRepo.recent(500)).filter((r) => r.action === "deploy").length;
    };
    const age = async (versionId: string, ms: number) => {
      const q = sql`update versions set created_at = ${Date.now() - ms} where id = ${versionId}`;
      if (client.dialect === "sqlite") client.db.run(q);
      else await client.db.execute(q);
    };
    return {
      app,
      canvases,
      versions,
      storage,
      uploadSessions,
      mkCanvas,
      get,
      put,
      json,
      deployAudits,
      age,
      sha: sha3,
    };
  }

  it("Covers AE1. the same release twice: 200 already_current, same version, and exactly one deploy audit row", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const first = await t.put(a.id, a.key, { "index.html": "one" }, { releaseId: R });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: "published", version: 1, releaseId: R });
    expect(first.body.publicationToken).toMatch(HEX32);
    const second = await t.put(a.id, a.key, { "index.html": "two" }, { releaseId: R });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      outcome: "already_current",
      version: 1,
      versionId: first.body.versionId,
      releaseId: R,
      publicationToken: first.body.publicationToken,
      fileCount: 1,
      warnings: [],
    });
    expect(await t.deployAudits()).toBe(1);
    expect((await t.versions.listByCanvas(a.id)).filter((v) => v.status === "ready")).toHaveLength(
      1,
    );
  });

  it("Covers AE3. readback shows the current release and the token the deploy returned", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const before = await t.get(a.id, a.key);
    expect(before.body.currentVersion).toBeNull();
    expect(before.body.publicationToken).toBe(a.token);
    const r = await t.put(a.id, a.key, { "index.html": "one" }, { releaseId: R });
    const after = await t.get(a.id, a.key);
    expect(after.body.publicationToken).toBe(r.body.publicationToken);
    expect(after.body.currentVersion).toEqual({
      id: r.body.versionId,
      number: 1,
      releaseId: R,
      createdAt: expect.any(Number),
    });
    expect(after.body.currentVersionId).toBe(r.body.versionId);
  });

  it("Covers AE4. a stale expected token is 409 PUBLICATION_CHANGED with the current publication; the live files are unchanged", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const t1 = (await t.get(a.id, a.key)).body.publicationToken as string;
    const editor = await t.put(a.id, a.key, { "index.html": "editor" }); // an intervening publish
    const res = await t.put(
      a.id,
      a.key,
      { "index.html": "mine" },
      { releaseId: R, expectedPublicationToken: t1 },
    );
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "PUBLICATION_CHANGED",
      message: expect.stringContaining("reassess"),
      current: {
        publicationToken: editor.body.publicationToken,
        versionId: editor.body.versionId,
        version: 1,
        releaseId: null,
      },
    });
    const live = await t.app.request(`/v1/canvases/${a.id}/files?path=index.html`, {
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(await live.text()).toBe("editor");
  });

  it("Covers AE5. a release that exists only in history is 409 RELEASE_NOT_CURRENT naming that version", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const v1 = await t.put(a.id, a.key, { "index.html": "r" }, { releaseId: R });
    const v2 = await t.put(a.id, a.key, { "index.html": "s" }, { releaseId: S });
    const rb = await t.json("POST", `/${a.id}/rollback`, a.key, { version: 1 });
    expect(rb.status).toBe(200);
    await t.age(v2.body.versionId as string, 120_000); // history, not a race
    const res = await t.put(a.id, a.key, { "index.html": "s again" }, { releaseId: S });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "RELEASE_NOT_CURRENT",
      release: { versionId: v2.body.versionId, version: 2 },
      current: { versionId: v1.body.versionId, version: 1, releaseId: R },
    });
    expect((await t.get(a.id, a.key)).body.currentVersionId).toBe(v1.body.versionId);
  });

  it("Covers AE8. a rejected ZIP with an expected token changes neither the token nor the pointer", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const live = await t.put(a.id, a.key, { "index.html": "ok" });
    const bad = await t.put(
      a.id,
      a.key,
      { "../escape.txt": "x", "index.html": "y" },
      { expectedPublicationToken: live.body.publicationToken as string },
    );
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("ZIP_SLIP_REJECTED");
    const after = await t.get(a.id, a.key);
    expect(after.body.publicationToken).toBe(live.body.publicationToken);
    expect(after.body.currentVersionId).toBe(live.body.versionId);
  });

  it("Covers AE10. cross-canvas: a foreign key is 403, a foreign token is a plain mismatch, no key is 401", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const b = await t.mkCanvas();
    const foreignKey = await t.put(
      b.id,
      a.key,
      { "index.html": "x" },
      { expectedPublicationToken: b.token },
    );
    expect(foreignKey.status).toBe(403);
    const foreignToken = await t.put(
      a.id,
      a.key,
      { "index.html": "x" },
      { expectedPublicationToken: b.token },
    );
    expect(foreignToken.status).toBe(409);
    expect(foreignToken.body.code).toBe("PUBLICATION_CHANGED");
    expect((await t.get(b.id, b.key)).body.currentVersion).toBeNull();
    const noKey = await t.app.request(
      `/v1/canvases/${a.id}/deploy?releaseId=${encodeURIComponent(R)}`,
      {
        method: "PUT",
        body: zipOf({ "index.html": "x" }),
      },
    );
    expect(noKey.status).toBe(401);
  });

  it("Covers AE11. callers without the new fields see today's behavior plus additive fields, and every action rotates the token", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const one = await t.put(a.id, a.key, { "index.html": "1" });
    expect(one.body).toMatchObject({
      outcome: "published",
      version: 1,
      releaseId: null,
      fileCount: 1,
    });
    expect(one.body.publicationToken).toMatch(HEX32);
    expect(one.body.publicationToken).not.toBe(a.token);
    const two = await t.put(a.id, a.key, { "index.html": "2" });
    const rb = await t.json("POST", `/${a.id}/rollback`, a.key, { version: 1 });
    expect(rb.status).toBe(200);
    expect(rb.body).toEqual({ url: expect.any(String), version: 1 });
    const afterRollback = (await t.get(a.id, a.key)).body.publicationToken;
    expect(afterRollback).not.toBe(two.body.publicationToken);
    expect(afterRollback).not.toBe(one.body.publicationToken); // never restored
    const un = await t.json("POST", `/${a.id}/unpublish`, a.key);
    expect(un.status).toBe(200);
    expect(un.body).toEqual({
      url: expect.any(String),
      publicationState: "draft",
      currentVersionId: null,
    });
    const afterUnpublish = await t.get(a.id, a.key);
    expect(afterUnpublish.body.publicationToken).not.toBe(afterRollback);
    expect(afterUnpublish.body.currentVersion).toBeNull();
    // Covers AE6 tail: an unpublished canvas still has a token and publishes with it.
    const again = await t.put(
      a.id,
      a.key,
      { "index.html": "3" },
      {
        expectedPublicationToken: afterUnpublish.body.publicationToken as string,
      },
    );
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe("published");
  });

  it("Covers AE12. staged: fields captured at begin are enforced at finalize; a fresh token at finalize publishes; a different release is refused", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const t1 = a.token;
    const begun = await t.json("POST", `/${a.id}/uploads`, a.key, {
      manifest: [{ path: "index.html", hash: t.sha("mine"), size: 4 }],
      releaseId: R,
      expectedPublicationToken: t1,
    });
    expect(begun.status).toBe(200);
    expect(begun.body).toEqual({ uploadId: expect.any(String), missingHashes: [t.sha("mine")] });
    const uploadId = begun.body.uploadId as string;
    const staged = await t.app.request(
      `/v1/canvases/${a.id}/uploads/${uploadId}/blobs/${t.sha("mine")}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${a.key}` },
        body: enc3("mine"),
      },
    );
    expect(staged.status).toBe(204);
    const editor = await t.put(a.id, a.key, { "index.html": "editor" }); // publication changes
    const stale = await t.json("POST", `/${a.id}/uploads/${uploadId}/finalize`, a.key);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: "PUBLICATION_CHANGED",
      current: { versionId: editor.body.versionId },
    });
    const fresh = await t.json("POST", `/${a.id}/uploads/${uploadId}/finalize`, a.key, {
      expectedPublicationToken: editor.body.publicationToken,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ outcome: "published", releaseId: R, version: 2 });
    expect(await t.deployAudits()).toBe(2);
    // A second session for a release that is now live: begin answers already_current itself.
    const again = await t.json("POST", `/${a.id}/uploads`, a.key, {
      manifest: [{ path: "index.html", hash: t.sha("other"), size: 5 }],
      releaseId: R,
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      outcome: "already_current",
      versionId: fresh.body.versionId,
    });
    expect(await t.deployAudits()).toBe(2);
    // A finalize release that differs from begin's is refused.
    const b2 = await t.json("POST", `/${a.id}/uploads`, a.key, {
      manifest: [{ path: "index.html", hash: t.sha("x"), size: 1 }],
      releaseId: S,
    });
    const mismatch = await t.json("POST", `/${a.id}/uploads/${b2.body.uploadId}/finalize`, a.key, {
      releaseId: R,
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe("RELEASE_ID_MISMATCH");
    const garbage = await t.json(
      "POST",
      `/${a.id}/uploads/${b2.body.uploadId}/finalize`,
      a.key,
      "{not json",
    );
    expect(garbage.status).toBe(400);
    expect(garbage.body.code).toBe("INVALID_REQUEST");
  });

  it("an invalid releaseId is 400 INVALID_RELEASE_ID and creates nothing", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const empty = await t.put(a.id, a.key, { "index.html": "x" }, { releaseId: "" });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("INVALID_RELEASE_ID");
    const long = await t.put(a.id, a.key, { "index.html": "x" }, { releaseId: "x".repeat(201) });
    expect(long.status).toBe(400);
    expect(await t.versions.listByCanvas(a.id)).toHaveLength(0);
  });

  it("version listings carry the immutable id and the release identity", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const r = await t.put(a.id, a.key, { "index.html": "x" }, { releaseId: R });
    await t.put(a.id, a.key, { "index.html": "y" });
    const list = await t.json("GET", `/${a.id}/versions`, a.key);
    const versions = list.body.versions as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({
      id: r.body.versionId,
      number: 1,
      releaseId: R,
      current: false,
    });
    expect(versions[0]).toMatchObject({ number: 2, releaseId: null, current: true });
  });

  it("an already_current short-circuit consumes a deploy rate-limit token like any attempt (KTD6)", async () => {
    const t = await setup({ deployPerMin: 2 });
    const a = await t.mkCanvas();
    expect((await t.put(a.id, a.key, { "index.html": "x" }, { releaseId: R })).status).toBe(200);
    const second = await t.put(a.id, a.key, { "index.html": "x" }, { releaseId: R });
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe("already_current");
    expect((await t.put(a.id, a.key, { "index.html": "x" }, { releaseId: R })).status).toBe(429);
  });

  it("a non-string coordination field is 400 INVALID_REQUEST at begin and at finalize, and opens or changes nothing", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const manifest = [{ path: "index.html", hash: t.sha("x"), size: 1 }];
    const bad = await t.json("POST", `/${a.id}/uploads`, a.key, { manifest, releaseId: 42 });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_REQUEST");
    expect(await t.uploadSessions.listActiveByCanvas(a.id, Date.now())).toHaveLength(0);
    const begun = await t.json("POST", `/${a.id}/uploads`, a.key, { manifest });
    expect(begun.status).toBe(200);
    const worse = await t.json("POST", `/${a.id}/uploads/${begun.body.uploadId}/finalize`, a.key, {
      expectedPublicationToken: ["x"],
    });
    expect(worse.status).toBe(400);
    expect(worse.body.code).toBe("INVALID_REQUEST");
    expect((await t.get(a.id, a.key)).body.currentVersion).toBeNull();
  });

  it("a finalize that itself resolves to already_current writes no deploy audit row (two sessions, one release)", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const open = async (content: string) => {
      const b = await t.json("POST", `/${a.id}/uploads`, a.key, {
        manifest: [{ path: "index.html", hash: t.sha(content), size: content.length }],
        releaseId: R,
      });
      expect(b.status).toBe(200);
      const staged = await t.app.request(
        `/v1/canvases/${a.id}/uploads/${b.body.uploadId}/blobs/${t.sha(content)}`,
        { method: "PUT", headers: { Authorization: `Bearer ${a.key}` }, body: enc3(content) },
      );
      expect(staged.status).toBe(204);
      return b.body.uploadId as string;
    };
    const first = await open("one");
    const second = await open("two");
    const f1 = await t.json("POST", `/${a.id}/uploads/${first}/finalize`, a.key);
    expect(f1.status).toBe(200);
    expect(f1.body).toMatchObject({ outcome: "published", releaseId: R });
    expect(await t.deployAudits()).toBe(1);
    const f2 = await t.json("POST", `/${a.id}/uploads/${second}/finalize`, a.key);
    expect(f2.status).toBe(200);
    expect(f2.body).toMatchObject({ outcome: "already_current", versionId: f1.body.versionId });
    expect(await t.deployAudits()).toBe(1);
  });

  it("an oversized finalize body is refused with 413 INVALID_REQUEST before it is buffered", async () => {
    const t = await setup();
    const a = await t.mkCanvas();
    const res = await t.json(
      "POST",
      `/${a.id}/uploads/${"0".repeat(32)}/finalize`,
      a.key,
      "x".repeat(17 * 1024),
    );
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("INVALID_REQUEST");
  });
});

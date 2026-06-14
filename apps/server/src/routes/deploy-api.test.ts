import { Buffer } from "node:buffer";
import { type Config, loadConfig } from "@canvas-drop/shared";
import { zipSync } from "fflate";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
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
  async function setup() {
    client = await makeTestDb("sqlite");
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const audit = createAuditLog(auditRepository(client), silent);
    const engine = deployEngine({
      config,
      canvases,
      versions,
      drafts,
      storage: memStorage(),
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

    const app = new Hono<AppEnv>();
    app.route("/v1/canvases", deployApiRoutes({ config, canvases, versions, engine, audit }));
    return { app, canvases, versions, mkCanvas, ownerId: owner.id };
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
    expect(((await draftRes.json()) as { publicationState: string }).publicationState).toBe(
      "draft",
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

  it("unpublish via the Bearer API: published → draft; 409 CANNOT_UNPUBLISH on a draft; wrong key → 403", async () => {
    const { app, mkCanvas } = await setup();
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

    // A's key cannot unpublish B's canvas.
    const cross = await app.request(`/v1/canvases/${b.id}/unpublish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.key}` },
    });
    expect(cross.status).toBe(403);
  });

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
  });
});

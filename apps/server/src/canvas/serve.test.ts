import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas, Manifest } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import type { StorageDriver } from "../storage/driver.js";
import { LocalDriver } from "../storage/local.js";
import { serveCanvas } from "./serve.js";
import { blobKey } from "./storage-keys.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

describe("serveCanvas (integration)", () => {
  let client: DbClient;
  let dir: string;
  let storage: StorageDriver;

  afterEach(async () => {
    await client?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup(opts: { spaFallback?: boolean } = {}) {
    client = await makeTestDb("sqlite");
    dir = await mkdtemp(join(tmpdir(), "cd-serve-"));
    storage = new LocalDriver(dir);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    if (opts.spaFallback) await canvases.updateSettings(cv.id, { spaFallback: true });

    // deploy a version: index.html + app.js + a hashed asset
    const files: Record<string, string> = {
      "index.html": "<h1>home</h1>",
      "app.js": "console.log(1)",
      "assets/app.abcdef12.js": "hashed",
      "danger.php": "<?php echo 1; ?>",
    };
    const enc = new TextEncoder();
    const manifest: Manifest = {};
    const v = await versions.createPending({
      canvasId: cv.id,
      number: 1,
      createdBy: owner.id,
      source: "folder",
    });
    for (const [path, body] of Object.entries(files)) {
      const bytes = enc.encode(body);
      const hash = `hash-${path}`;
      // Bytes live at the content-addressed blob key (per-canvas), keyed by hash.
      await storage.put(blobKey(cv.id, hash), bytes);
      manifest[path] = { size: bytes.length, hash, mime: "x" };
    }
    await versions.markReady(v.id, { fileCount: 4, totalBytes: 0, manifest });
    await canvases.setCurrentVersion(cv.id, v.id);
    const updated = (await canvases.findById(cv.id)) as Canvas;

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("canvas", updated);
      await next();
    });
    app.all("*", serveCanvas({ config, versions, storage }));
    return { app, canvas: updated };
  }

  it("serves files with the right MIME and body", async () => {
    const { app } = await setup();
    const html = await app.request("/c/s/index.html");
    expect(html.status).toBe(200);
    expect(html.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(await html.text()).toContain("home");

    const js = await app.request("/c/s/app.js");
    expect(js.headers.get("Content-Type")).toMatch(/text\/javascript/);
  });

  it("serves index.html at the canvas root", async () => {
    const { app } = await setup();
    expect((await app.request("/c/s/")).status).toBe(200);
    expect(await (await app.request("/c/s/")).text()).toContain("home");
  });

  it("unknown path → 404 without SPA fallback, root index with it", async () => {
    const off = await setup({ spaFallback: false });
    expect((await off.app.request("/c/s/missing")).status).toBe(404);
    const on = await setup({ spaFallback: true });
    expect((await on.app.request("/c/s/missing")).status).toBe(200);
  });

  it("404 is JSON for API clients but a friendly HTML page for browsers", async () => {
    const { app } = await setup({ spaFallback: false });

    // No Accept header (programmatic) → stable JSON, security headers intact.
    const api = await app.request("/c/s/missing");
    expect(api.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await api.json()).toEqual({ error: "not_found" });
    expect(api.headers.get("X-Content-Type-Options")).toBe("nosniff");

    // Browser (Accept: text/html) → an HTML page, not raw JSON.
    const browser = await app.request("/c/s/missing", { headers: { Accept: "text/html" } });
    expect(browser.status).toBe(404);
    expect(browser.headers.get("Content-Type")).toMatch(/text\/html/);
    const html = await browser.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Page not found");
    expect(browser.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("serves a .php file as text/plain with nosniff (never executed)", async () => {
    const { app } = await setup();
    const res = await app.request("/c/s/danger.php");
    expect(res.headers.get("Content-Type")).toMatch(/text\/plain/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets ETag + no-cache for stable names, immutable for content-hashed names", async () => {
    const { app } = await setup();
    const html = await app.request("/c/s/index.html");
    expect(html.headers.get("ETag")).toBeTruthy();
    expect(html.headers.get("Cache-Control")).toBe("no-cache");
    const hashed = await app.request("/c/s/assets/app.abcdef12.js");
    expect(hashed.headers.get("Cache-Control")).toContain("immutable");
  });

  it("conditional GET with matching If-None-Match → 304", async () => {
    const { app } = await setup();
    const first = await app.request("/c/s/index.html");
    const etag = first.headers.get("ETag") as string;
    const second = await app.request("/c/s/index.html", { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(304);
  });

  it("sets the §12.4 security headers", async () => {
    const { app } = await setup();
    const res = await app.request("/c/s/index.html");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("404 when the canvas has no current version", async () => {
    client = await makeTestDb("sqlite");
    dir = await mkdtemp(join(tmpdir(), "cd-serve-"));
    storage = new LocalDriver(dir);
    const versions = versionsRepository(client);
    const cv = { slug: "s", currentVersionId: null } as Canvas;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("canvas", cv);
      await next();
    });
    app.all("*", serveCanvas({ config, versions, storage }));
    expect((await app.request("/c/s/index.html")).status).toBe(404);
  });
});

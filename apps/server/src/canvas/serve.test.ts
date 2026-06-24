import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas, Manifest } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
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

  async function setup(
    opts: {
      spaFallback?: boolean;
      access?: "private" | "specific_people" | "whole_org" | "public_link";
      passwordHash?: string;
      sharedExpiresAt?: number;
      serveConfig?: Config;
    } = {},
  ) {
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
    if (opts.access) await canvases.updateSettings(cv.id, { access: opts.access });
    if (opts.sharedExpiresAt !== undefined)
      await canvases.updateSettings(cv.id, { sharedExpiresAt: opts.sharedExpiresAt });
    if (opts.passwordHash) await canvases.setPassword(cv.id, opts.passwordHash);

    // deploy a version: index.html + app.js + a hashed asset
    const files: Record<string, string> = {
      "index.html": "<h1>home</h1>",
      "app.js": "console.log(1)",
      "assets/app.abcdef12.js": "hashed",
      "danger.php": "<?php echo 1; ?>",
      "logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
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
    await versions.markReady(v.id, {
      fileCount: Object.keys(manifest).length,
      totalBytes: 0,
      manifest,
    });
    await canvases.setCurrentVersion(cv.id, v.id);
    const updated = (await canvases.findById(cv.id)) as Canvas;
    const usage = usageEventsRepository(client);

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("canvas", updated);
      c.set("user", owner);
      await next();
    });
    app.all("*", serveCanvas({ config: opts.serveConfig ?? config, versions, storage, usage }));
    return { app, canvas: updated, owner, usage, versions };
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

  it("path mode: an SVG is forced to download (Content-Disposition: attachment) — cross-canvas XSS guard (server-canvas-5)", async () => {
    // Default config is path mode; all canvases share one origin, so an inline SVG
    // with embedded <script> would execute in the shared origin.
    const { app } = await setup();
    const res = await app.request("/c/s/logo.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/svg\+xml/);
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
  });

  it("subdomain mode: an SVG is served inline (no attachment) — each canvas is its own origin (server-canvas-5)", async () => {
    const subdomainConfig = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_URL_MODE: "subdomain",
      CANVAS_DROP_BASE_URL: "https://canvases.example.com",
    });
    const { app } = await setup({ serveConfig: subdomainConfig });
    // In subdomain mode the slug comes from the host; the asset path is the bare path.
    const res = await app.request("/logo.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/image\/svg\+xml/);
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("auth-gated canvas: HTML is private/no-cache, hashed asset private/immutable", async () => {
    // Default access is `private` — a shared CDN must never store its bytes (§12.2).
    const { app } = await setup();
    const html = await app.request("/c/s/index.html");
    expect(html.headers.get("ETag")).toBeTruthy();
    expect(html.headers.get("Cache-Control")).toBe("private, no-cache");
    const hashed = await app.request("/c/s/assets/app.abcdef12.js");
    expect(hashed.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
  });

  it("public_link canvas: HTML is shared-cacheable (s-maxage), hashed is public/immutable", async () => {
    // Only the anonymously-public rung may be cached by a CDN. TTL comes from config
    // (default 300); the browser still revalidates each load via max-age=0.
    const { app } = await setup({ access: "public_link" });
    const html = await app.request("/c/s/index.html");
    expect(html.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=300");
    const hashed = await app.request("/c/s/assets/app.abcdef12.js");
    expect(hashed.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("public_link HTML falls back to public/no-cache when edge caching is off (TTL 0)", async () => {
    const serveConfig = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_PUBLIC_EDGE_CACHE_TTL: "0",
    });
    const { app } = await setup({ access: "public_link", serveConfig });
    const html = await app.request("/c/s/index.html");
    expect(html.headers.get("Cache-Control")).toBe("public, no-cache");
  });

  it("public_link WITH a password is private — a CDN must never cache a gated canvas (§12.2)", async () => {
    const { app } = await setup({ access: "public_link", passwordHash: "hashed" });
    const html = await app.request("/c/s/index.html");
    expect(html.headers.get("Cache-Control")).toBe("private, no-cache");
    const hashed = await app.request("/c/s/assets/app.abcdef12.js");
    expect(hashed.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
  });

  it("EXPIRED public_link is private — an expired share is no longer shared-cacheable", async () => {
    const { app } = await setup({ access: "public_link", sharedExpiresAt: Date.now() - 1000 });
    const html = await app.request("/c/s/index.html");
    expect(html.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  it("public_link expiring soon clamps s-maxage to the time left, not the full TTL", async () => {
    // Expiry ~30s out, well under the 300s default TTL → s-maxage must not outlive it.
    const { app } = await setup({ access: "public_link", sharedExpiresAt: Date.now() + 30_000 });
    const html = await app.request("/c/s/index.html");
    const cc = html.headers.get("Cache-Control") as string;
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(cc)?.[1]);
    expect(cc).toMatch(/^public, max-age=0, s-maxage=/);
    expect(sMaxAge).toBeGreaterThan(0);
    expect(sMaxAge).toBeLessThanOrEqual(30);
  });

  it("clearing an expired share re-enables full shared caching", async () => {
    // An expired public_link serves private; clearing the expiry must restore the
    // full-TTL public header (the predicate has no lingering state).
    const { app, canvas, owner, versions } = await setup({
      access: "public_link",
      sharedExpiresAt: Date.now() - 1000,
    });
    expect((await app.request("/c/s/index.html")).headers.get("Cache-Control")).toBe(
      "private, no-cache",
    );
    await canvasesRepository(client).updateSettings(canvas.id, { sharedExpiresAt: null });
    // Re-serve with a fresh middleware bound to the updated row.
    const updated = (await canvasesRepository(client).findById(canvas.id)) as Canvas;
    const app2 = new Hono<AppEnv>();
    app2.use("*", async (c, next) => {
      c.set("canvas", updated);
      c.set("user", owner);
      await next();
    });
    app2.all("*", serveCanvas({ config, versions, storage, usage: usageEventsRepository(client) }));
    expect((await app2.request("/c/s/index.html")).headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=300",
    );
  });

  it("conditional GET with matching If-None-Match → 304", async () => {
    const { app } = await setup();
    const first = await app.request("/c/s/index.html");
    const etag = first.headers.get("ETag") as string;
    const second = await app.request("/c/s/index.html", { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(304);
  });

  it('conditional GET still 304s when a CDN weakened the ETag to W/"…"', async () => {
    // A CDN that compresses our response downgrades the strong validator to weak and
    // echoes it back in If-None-Match; we must still recognize it as a content match.
    const { app } = await setup();
    const first = await app.request("/c/s/index.html");
    const etag = first.headers.get("ETag") as string;
    const weak = await app.request("/c/s/index.html", {
      headers: { "If-None-Match": `W/${etag}` },
    });
    expect(weak.status).toBe(304);
  });

  it("conditional GET 304s when our ETag is one of a comma-separated If-None-Match list", async () => {
    const { app } = await setup();
    const first = await app.request("/c/s/index.html");
    const etag = first.headers.get("ETag") as string;
    const res = await app.request("/c/s/index.html", {
      headers: { "If-None-Match": `"other-etag", W/${etag}` },
    });
    expect(res.status).toBe(304);
  });

  it("sets the §12.4 security headers (incl. COOP, added M7) — path mode", async () => {
    const { app } = await setup();
    const res = await app.request("/c/s/index.html");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    // path mode: 'self' covers both canvases and the dashboard (same origin).
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("frame-ancestors includes the dashboard origin in subdomain mode", async () => {
    const subdomainConfig: Config = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_URL_MODE: "subdomain",
      CANVAS_DROP_BASE_URL: "https://canvas-drop.com",
    });
    const { app } = await setup({ serveConfig: subdomainConfig });
    // In subdomain mode there is no /c/:slug prefix; the canvas is at the root.
    const res = await app.request("/index.html");
    // The dashboard (apex) must be listed so it can embed canvases in iframes.
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self' https://canvas-drop.com",
    );
  });

  it("404 when the manifest references a hash whose blob is missing from storage", async () => {
    // Mirror setup() but deliberately DON'T write the blob for index.html.
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
    const v = await versions.createPending({
      canvasId: cv.id,
      number: 1,
      createdBy: owner.id,
      source: "folder",
    });
    const manifest: Manifest = {
      "index.html": { size: 3, hash: "missing-hash", mime: "text/html" },
    };
    await versions.markReady(v.id, { fileCount: 1, totalBytes: 3, manifest });
    await canvases.setCurrentVersion(cv.id, v.id);
    const updated = (await canvases.findById(cv.id)) as Canvas;

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("canvas", updated);
      await next();
    });
    app.all("*", serveCanvas({ config, versions, storage, usage: usageEventsRepository(client) }));
    // The manifest resolves the path, but storage.get returns null → 404 (resilience).
    expect((await app.request("/c/s/index.html")).status).toBe(404);
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
    app.all("*", serveCanvas({ config, versions, storage, usage: usageEventsRepository(client) }));
    expect((await app.request("/c/s/index.html")).status).toBe(404);
  });

  describe("view recording (D24, §6.9.6)", () => {
    it("records exactly one view for an HTML-document load, attributed to the viewer", async () => {
      const { app, canvas, usage } = await setup();
      const res = await app.request("/c/s/index.html");
      expect(res.status).toBe(200);
      // Fire-and-forget: let the background record settle before asserting.
      await new Promise((r) => setTimeout(r, 20));
      expect(await usage.countByType(canvas.id, null)).toEqual({ view: 1 });
    });

    it("records a view when serving index.html at the canvas root", async () => {
      const { app, canvas, usage } = await setup();
      await app.request("/c/s/");
      await new Promise((r) => setTimeout(r, 20));
      expect((await usage.countByType(canvas.id, null)).view).toBe(1);
    });

    it("records NO view for sub-asset (js/css/hashed) requests", async () => {
      const { app, canvas, usage } = await setup();
      await app.request("/c/s/app.js");
      await app.request("/c/s/assets/app.abcdef12.js");
      await new Promise((r) => setTimeout(r, 20));
      expect((await usage.countByType(canvas.id, null)).view ?? 0).toBe(0);
    });

    it("dedupes repeat loads within the session window (one view, not three)", async () => {
      const { app, canvas, usage } = await setup();
      await app.request("/c/s/index.html");
      await new Promise((r) => setTimeout(r, 20));
      await app.request("/c/s/index.html");
      await app.request("/c/s/index.html");
      await new Promise((r) => setTimeout(r, 20));
      expect((await usage.countByType(canvas.id, null)).view).toBe(1);
    });

    it("still records a view on a 304 revalidation that starts a session", async () => {
      const { app, canvas, usage } = await setup();
      const first = await app.request("/c/s/index.html");
      const etag = first.headers.get("ETag") as string;
      await new Promise((r) => setTimeout(r, 20));
      // Clear the view so the 304 is the session's first load, then revalidate.
      await usage.pruneBefore(Date.now() + 1);
      const second = await app.request("/c/s/index.html", {
        headers: { "If-None-Match": etag },
      });
      expect(second.status).toBe(304);
      await new Promise((r) => setTimeout(r, 20));
      expect((await usage.countByType(canvas.id, null)).view).toBe(1);
    });

    it("a failing metering write never breaks or delays the serve, but is logged", async () => {
      const { canvas, owner, versions } = await setup();
      // Replace the usage dep with one whose recordView rejects: serve must still 200.
      const failingUsage: ReturnType<typeof usageEventsRepository> = {
        ...usageEventsRepository(client),
        recordView: () => Promise.reject(new Error("boom")),
      };
      // Capture warn() so we can assert the swallowed failure leaves a trail.
      const warned: unknown[] = [];
      const log = { warn: (obj: unknown) => warned.push(obj) } as unknown as Parameters<
        typeof serveCanvas
      >[0]["log"];
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("canvas", canvas);
        c.set("user", owner);
        await next();
      });
      app.all("*", serveCanvas({ config, versions, storage, usage: failingUsage, log }));
      const res = await app.request("/c/s/index.html");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("home");
      // Let the fire-and-forget catch run, then assert it warned.
      await new Promise((r) => setTimeout(r, 20));
      expect(warned).toHaveLength(1);
    });

    it("records a view for an SPA-fallback navigation (non-root path → index.html)", async () => {
      // Plan 005 U1 scenario: a deep-link on a spaFallback canvas resolves to
      // index.html (an HTML document) and must still count as a view.
      const { app, canvas, usage } = await setup({ spaFallback: true });
      const res = await app.request("/c/s/some/client-route");
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect((await usage.countByType(canvas.id, null)).view).toBe(1);
    });

    it("records an anonymous view for a public-link visitor (U11)", async () => {
      const { canvas, usage, versions } = await setup();
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("canvas", canvas);
        // An anonymous public visitor (the U7 carve-out set this principal).
        c.set("principal", { kind: "anonymous" });
        await next();
      });
      app.all("*", serveCanvas({ config, versions, storage, usage }));
      await app.request("/c/s/index.html");
      await new Promise((r) => setTimeout(r, 20));
      // The view is recorded and attributed to the anonymous sentinel (R18).
      expect((await usage.countByType(canvas.id, null)).view ?? 0).toBe(1);
    });
  });
});

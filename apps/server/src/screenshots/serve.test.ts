import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas, User } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { canvasAccess } from "../canvas/authorization.js";
import { screenshotKey } from "../canvas/storage-keys.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { PREVIEW_ASSET_PATH, servePreview } from "./serve.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const PREVIEW_URL = `/c/s/${PREVIEW_ASSET_PATH}`;
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF" — stand-in bytes

describe("servePreview — handler logic (U7)", () => {
  /** Mount servePreview with the canvas pre-set (as canvasAccess would) + a terminal. */
  function app(opts: { enabled: boolean; storeKey?: string; previewMode?: string }) {
    const storage = memStorage();
    if (opts.storeKey) storage.put(opts.storeKey, webp, { contentType: "image/webp" });
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("canvas", {
        id: "cv1",
        slug: "s",
        status: "active",
        previewMode: opts.previewMode ?? "auto",
      } as Canvas);
      await next();
    });
    a.use("*", servePreview({ config, storage, enabled: async () => opts.enabled }));
    a.all("*", (c) => c.text("fell-through-to-content", 418));
    return a;
  }

  it("serves the stored WebP for the requested rendition", async () => {
    const res = await app({ enabled: true, storeKey: screenshotKey("cv1", "card") }).request(
      PREVIEW_URL,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(webp);
  });

  it("404s when the feature is effective-disabled (→ client shows GenerativeCover)", async () => {
    const res = await app({ enabled: false, storeKey: screenshotKey("cv1", "card") }).request(
      PREVIEW_URL,
    );
    expect(res.status).toBe(404);
  });

  it("404s when no preview has been captured yet", async () => {
    const res = await app({ enabled: true }).request(PREVIEW_URL);
    expect(res.status).toBe(404);
  });

  it("404s when previewMode is 'off' even with a stored preview and pipeline on", async () => {
    const res = await app({
      enabled: true,
      previewMode: "off",
      storeKey: screenshotKey("cv1", "card"),
    }).request(PREVIEW_URL);
    expect(res.status).toBe(404);
  });

  it("serves a 'custom' preview even when the capture pipeline is disabled", async () => {
    const res = await app({
      enabled: false,
      previewMode: "custom",
      storeKey: screenshotKey("cv1", "card"),
    }).request(PREVIEW_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
  });

  it("falls through to content for non-preview paths", async () => {
    const res = await app({ enabled: true }).request("/c/s/index.html");
    expect(res.status).toBe(418);
  });

  it("defaults to the card rendition but honors ?rendition=", async () => {
    const storage = memStorage();
    storage.put(screenshotKey("cv1", "og"), webp, { contentType: "image/webp" });
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("canvas", { id: "cv1", slug: "s", status: "active" } as Canvas);
      await next();
    });
    a.use("*", servePreview({ config, storage, enabled: async () => true }));
    a.all("*", (c) => c.notFound());
    expect((await a.request(`${PREVIEW_URL}?rendition=og`)).status).toBe(200);
    expect((await a.request(`${PREVIEW_URL}?rendition=card`)).status).toBe(404); // only og stored
  });
});

describe("servePreview — access gating via the real canvas chain (U7 / R5)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function chain() {
    client = await makeTestDb("sqlite");
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
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
    const cv = await canvases.create({ ownerId: owner.id, slug: "s", apiKeyHash: "h" });
    // private by default; give it a current version so it's "live"
    const storage = memStorage();
    storage.put(screenshotKey(cv.id, "card"), webp, { contentType: "image/webp" });

    const make = (user: User) => {
      const a = new Hono<AppEnv>();
      a.use("*", async (c, next) => {
        c.set("user", user);
        c.set("role", "canvas");
        c.set("canvasSlug", "s");
        await next();
      });
      a.use("*", canvasAccess({ canvases }));
      a.use("*", servePreview({ config, storage, enabled: async () => true }));
      a.all("*", (c) => c.notFound());
      return a;
    };
    return { ownerApp: make(owner), otherApp: make(other) };
  }

  it("serves a PRIVATE canvas's preview to the owner", async () => {
    const { ownerApp } = await chain();
    expect((await ownerApp.request(PREVIEW_URL)).status).toBe(200);
  });

  it("denies a private canvas's preview to a non-owner (canvasAccess 404s before serving) — R5", async () => {
    const { otherApp } = await chain();
    expect((await otherApp.request(PREVIEW_URL)).status).toBe(404);
  });
});

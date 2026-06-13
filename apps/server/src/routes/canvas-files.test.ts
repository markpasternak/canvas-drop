import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProvider } from "../ai/testing.js";
import { filesService, MAX_CANVAS_BYTES } from "../canvas/files-service.js";
import type { DbClient } from "../db/factory.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { filesRepository } from "../db/repositories/files.js";
import { kvRepository } from "../db/repositories/kv.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { canvasApiRoutes } from "./canvas-api.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

function buildApi(client: DbClient, userId: string, storage = memStorage()) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: userId,
      email: "o@x.com",
      name: "o",
      avatarUrl: null,
      isAdmin: false,
    } as never);
    await next();
  });
  app.route(
    "/v1/c/:slug",
    canvasApiRoutes({
      config,
      canvases: canvasesRepository(client),
      kv: kvRepository(client),
      files: filesService({ files: filesRepository(client), storage }),
      usage: usageEventsRepository(client),
      aiUsage: aiUsageRepository(client),
      aiProvider: fakeProvider({ deltas: ["ok"] }),
    }),
  );
  return app;
}

async function setup(client: DbClient, backendEnabled = true, capFiles = true) {
  const owner = await usersRepository(client).upsert({
    providerSub: "owner",
    email: "o@x.com",
    name: "o",
    isAdmin: false,
  });
  const cv = await canvasesRepository(client).create({
    ownerId: owner.id,
    slug: "app",
    apiKeyHash: "h",
    backendEnabled,
  });
  if (!capFiles) await canvasesRepository(client).updateCapabilities(cv.id, { files: false });
  return { ownerId: owner.id, canvasId: cv.id };
}

function upload(name: string, type: string, body: string | ArrayBuffer): RequestInit {
  const form = new FormData();
  form.set("file", new File([body], name, { type }));
  return { method: "POST", body: form };
}

describe("canvas Files routes", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("upload→list→content round-trips bytes + metadata; meters file_op", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId, canvasId } = await setup(client);
    const app = buildApi(client, ownerId);
    const up = await app.request("/v1/c/app/files", upload("hi.txt", "text/plain", "hello"));
    expect(up.status).toBe(201);
    const { id } = (await up.json()) as { id: string };

    const list = (await (await app.request("/v1/c/app/files")).json()) as {
      files: { id: string }[];
    };
    expect(list.files.map((f) => f.id)).toEqual([id]);

    const content = await app.request(`/v1/c/app/files/${id}/content`);
    expect(await content.text()).toBe("hello");
    expect(
      (await usageEventsRepository(client).countByType(canvasId, null)).file_op,
    ).toBeGreaterThan(0);
  });

  it("content of a safe raster is inline; nosniff present", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client);
    const app = buildApi(client, ownerId);
    const up = await app.request("/v1/c/app/files", upload("a.png", "image/png", "PNGDATA"));
    const { id } = (await up.json()) as { id: string };
    const res = await app.request(`/v1/c/app/files/${id}/content`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("uploaded SVG is served as attachment, never inline (stored-XSS gate)", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client);
    const app = buildApi(client, ownerId);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const up = await app.request("/v1/c/app/files", upload("x.svg", "image/svg+xml", svg));
    const { id } = (await up.json()) as { id: string };
    const res = await app.request(`/v1/c/app/files/${id}/content`);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("delete removes the file; content 404s after", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client);
    const app = buildApi(client, ownerId);
    const up = await app.request("/v1/c/app/files", upload("a.txt", "text/plain", "x"));
    const { id } = (await up.json()) as { id: string };
    expect((await app.request(`/v1/c/app/files/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/v1/c/app/files/${id}/content`)).status).toBe(404);
  });

  it("rejects a file over the 25 MB limit (413)", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client);
    const app = buildApi(client, ownerId);
    const big = new ArrayBuffer(25 * 1024 * 1024 + 1);
    const res = await app.request(
      "/v1/c/app/files",
      upload("big.bin", "application/octet-stream", big),
    );
    expect(res.status).toBe(413);
  });

  it("403s when the files capability is off", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client, true, false);
    const app = buildApi(client, ownerId);
    expect((await app.request("/v1/c/app/files")).status).toBe(403);
  });

  it("403s when backend is off entirely", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client, false);
    const app = buildApi(client, ownerId);
    expect((await app.request("/v1/c/app/files")).status).toBe(403);
  });

  it("upload exceeding the canvas quota → 409 QUOTA_EXCEEDED", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId, canvasId } = await setup(client);
    await filesRepository(client).insert({
      id: "seed",
      canvasId,
      filename: "big",
      mime: "application/octet-stream",
      sizeBytes: MAX_CANVAS_BYTES,
      storageKey: `files/${canvasId}/seed`,
      uploadedBy: ownerId,
    });
    const app = buildApi(client, ownerId);
    const res = await app.request("/v1/c/app/files", upload("more.txt", "text/plain", "x"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("QUOTA_EXCEEDED");
  });

  it("files are isolated across canvases", async () => {
    client = await makeTestDb("sqlite");
    const { ownerId } = await setup(client);
    await canvasesRepository(client).create({
      ownerId,
      slug: "other",
      apiKeyHash: "h2",
      backendEnabled: true,
    });
    const app = buildApi(client, ownerId);
    const up = await app.request("/v1/c/app/files", upload("a.txt", "text/plain", "secret"));
    const { id } = (await up.json()) as { id: string };
    expect((await app.request(`/v1/c/other/files/${id}/content`)).status).toBe(404);
  });
});

import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { filesService } from "../canvas/files-service.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { filesRepository } from "../db/repositories/files.js";
import { kvRepository } from "../db/repositories/kv.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { canvasApiRoutes } from "./canvas-api.js";

const devConfig: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" }); // path mode
const subConfig: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvases.example.com",
});

async function seedUser(client: DbClient, isAdmin = false) {
  return usersRepository(client).upsert({
    providerSub: "owner",
    email: "owner@example.com",
    name: "Owner",
    isAdmin,
  });
}

/** Build an app that injects `user` (stand-in for the gateway) then mounts the API. */
function buildApi(
  client: DbClient,
  user: { id: string; isAdmin?: boolean; email?: string; name?: string },
  config = devConfig,
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: user.id,
      email: user.email ?? "owner@example.com",
      name: user.name ?? "Owner",
      avatarUrl: null,
      isAdmin: user.isAdmin ?? false,
    } as never);
    await next();
  });
  app.route(
    "/v1/c/:slug",
    canvasApiRoutes({
      config,
      canvases: canvasesRepository(client),
      kv: kvRepository(client),
      files: filesService({ files: filesRepository(client), storage: memStorage() }),
      usage: usageEventsRepository(client),
    }),
  );
  return app;
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("canvasApiRoutes (runtime seam + me)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function canvas(backendEnabled: boolean, slug = "app") {
    const owner = await seedUser(client);
    const cv = await canvasesRepository(client).create({
      ownerId: owner.id,
      slug,
      apiKeyHash: `h-${slug}`,
      backendEnabled,
    });
    return { owner, cv };
  }

  it("me returns exactly {id,email,name,avatarUrl} (no isAdmin) when backend is on", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await canvas(true);
    const res = await buildApi(client, { id: owner.id, isAdmin: true }).request("/v1/c/app/me");
    expect(res.status).toBe(200);
    const body = (await jsonOf<Record<string, unknown>>(res)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["avatarUrl", "email", "id", "name"]);
    expect(body.isAdmin).toBeUndefined();
  });

  it("me 403s when backend is off (identity capability gated)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await canvas(false);
    const res = await buildApi(client, { id: owner.id }).request("/v1/c/app/me");
    expect(res.status).toBe(403);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("CAPABILITY_DISABLED");
  });

  it("404s a nonexistent / hidden canvas (no existence leak)", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client);
    const res = await buildApi(client, { id: owner.id }).request("/v1/c/ghost/me");
    expect(res.status).toBe(404);
  });

  it("subdomain mode: Origin matching the slug is allowed + gets credentialed CORS", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await canvas(true);
    const res = await buildApi(client, { id: owner.id }, subConfig).request("/v1/c/app/me", {
      headers: { origin: "https://app.canvases.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.canvases.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("subdomain mode: a different canvas's Origin is rejected (cross-canvas, §12.0 #4)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await canvas(true);
    const res = await buildApi(client, { id: owner.id }, subConfig).request("/v1/c/app/me", {
      headers: { origin: "https://evil.canvases.example.com" },
    });
    expect(res.status).toBe(403);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("CROSS_CANVAS_FORBIDDEN");
  });

  it("path mode: a cross-site Sec-Fetch-Site is rejected (best-effort §12.2)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await canvas(true);
    const res = await buildApi(client, { id: owner.id }).request("/v1/c/app/me", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("path mode: a Referer for a prefix-sharing canvas is rejected (segment boundary)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await canvas(true); // slug "app"
    // Same-origin request, but the page is canvas "app-evil" calling /v1/c/app.
    const res = await buildApi(client, { id: owner.id }).request("/v1/c/app/me", {
      headers: {
        "sec-fetch-site": "same-origin",
        referer: "http://localhost/c/app-evil/index.html",
      },
    });
    expect(res.status).toBe(403);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("CROSS_CANVAS_FORBIDDEN");
  });

  it("a password-protected shared canvas's API stays closed without a gate grant (§12.0 #3)", async () => {
    client = await makeTestDb("sqlite");
    const { cv } = await canvas(true);
    await canvasesRepository(client).updateSettings(cv.id, { shared: true });
    await canvasesRepository(client).setPassword(cv.id, "argon2hash");
    const other = await usersRepository(client).upsert({
      providerSub: "viewer",
      email: "v@x.com",
      name: "V",
      isAdmin: false,
    });
    // Non-owner viewer with no gate cookie → blocked.
    const blocked = await buildApi(client, { id: other.id }).request("/v1/c/app/me");
    expect(blocked.status).toBe(403);
    expect((await jsonOf<{ code: string }>(blocked)).code).toBe("PASSWORD_REQUIRED");
    // Owner bypasses the gate.
    const ownerRes = await buildApi(client, { id: cv.ownerId }).request("/v1/c/app/me");
    expect(ownerRes.status).toBe(200);
  });

  it("path mode: same-origin request is allowed", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await canvas(true);
    const res = await buildApi(client, { id: owner.id }).request("/v1/c/app/me", {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });
});

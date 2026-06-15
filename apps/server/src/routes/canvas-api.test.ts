import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProvider } from "../ai/testing.js";
import type { AuditLog } from "../audit/audit-log.js";
import { filesService } from "../canvas/files-service.js";
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

const noopAudit: AuditLog = { recordAudit() {}, flush: async () => {}, record() {} };

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
      audit: noopAudit,
      aiUsage: aiUsageRepository(client),
      aiProvider: fakeProvider({ deltas: ["ok"] }),
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

  it("me returns {id,email,name,avatarUrl,kind} (no isAdmin) when backend is on", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await canvas(true);
    const res = await buildApi(client, { id: owner.id, isAdmin: true }).request("/v1/c/app/me");
    expect(res.status).toBe(200);
    const body = (await jsonOf<Record<string, unknown>>(res)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["avatarUrl", "email", "id", "kind", "name"]);
    expect(body.kind).toBe("member");
    expect(body.isAdmin).toBeUndefined();
  });

  it("me 403s when backend is off (identity capability gated)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await canvas(false);
    const res = await buildApi(client, { id: owner.id }).request("/v1/c/app/me");
    expect(res.status).toBe(403);
    expect((await jsonOf<{ code: string }>(res)).code).toBe("CAPABILITY_DISABLED");
  });

  it("runtime API on a DISABLED canvas → 403 { code: DISABLED }, admin not exempted (§12.0 #5)", async () => {
    client = await makeTestDb("sqlite");
    const { owner, cv } = await canvas(true);
    await canvasesRepository(client).setDisabled(cv.id, "policy");
    // Owner/admin alike are denied — disabled fires before owner/admin.
    const asOwner = await buildApi(client, { id: owner.id }).request("/v1/c/app/me");
    expect(asOwner.status).toBe(403);
    expect((await jsonOf<{ code: string }>(asOwner)).code).toBe("DISABLED");
    const asAdmin = await buildApi(client, { id: owner.id, isAdmin: true }).request("/v1/c/app/me");
    expect(asAdmin.status).toBe(403);
    expect((await jsonOf<{ code: string }>(asAdmin)).code).toBe("DISABLED");
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

  it("subdomain mode: file CONTENT carries credentialed CORS (raw-Response regression, §9.4)", async () => {
    client = await makeTestDb("sqlite");
    const { owner } = await canvas(true);
    const origin = "https://app.canvases.example.com";
    // One app instance so upload + content share the in-memory storage.
    const app = buildApi(client, { id: owner.id }, subConfig);

    const form = new FormData();
    form.set("file", new File(["# hello"], "doc.md", { type: "text/markdown" }));
    const up = await app.request("/v1/c/app/files", {
      method: "POST",
      body: form,
      headers: { origin },
    });
    expect(up.status).toBe(201);
    const { id } = await jsonOf<{ id: string }>(up);

    const res = await app.request(`/v1/c/app/files/${id}/content`, { headers: { origin } });
    expect(res.status).toBe(200);
    // The bug: the content handler returned a raw `new Response`, dropping the
    // CORS headers the isolation middleware set → cross-origin fetch() was blocked.
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(await res.text()).toBe("# hello");
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
    await canvasesRepository(client).updateSettings(cv.id, { access: "whole_org" });
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

describe("canvasApiRoutes — guest/anonymous primitives (U9)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  const aiConfig: Config = loadConfig({
    CANVAS_DROP_AUTH_MODE: "dev",
    CANVAS_DROP_AI_API_KEY: "sk-test",
  });

  /** Mount the runtime API with a pre-set non-org principal (the U7 carve-out's
   *  job in production), no org user — mirrors a guest/anonymous request. */
  function buildApiAs(
    client: DbClient,
    principal: import("../http/types.js").Principal,
    config = devConfig,
  ) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", principal);
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
        audit: noopAudit,
        aiUsage: aiUsageRepository(client),
        aiProvider: fakeProvider({ deltas: ["ok"] }),
      }),
    );
    return app;
  }

  async function seedCanvas(access: "public_link" | "specific_people", guestEmail?: string) {
    const owner = await usersRepository(client).upsert({
      providerSub: "o",
      email: "o@example.com",
      name: "O",
      isAdmin: false,
    });
    const repo = canvasesRepository(client);
    const cv = await repo.create({
      ownerId: owner.id,
      slug: "app",
      apiKeyHash: "h",
      backendEnabled: true,
    });
    await repo.setAccess(cv.id, access);
    // A public_link canvas only exists while its owner holds the publish capability
    // (U10) — grant it so resolveAccessContext resolves publicEnabled=true.
    if (access === "public_link") await usersRepository(client).setPublishPublic(owner.id, true);
    if (guestEmail)
      await repo.addAllowlistEntry({ canvasId: cv.id, principalKind: "guest", email: guestEmail });
    return cv;
  }

  it("anonymous on a public_link canvas: every runtime primitive is refused (STATIC_ONLY)", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas("public_link");
    const app = buildApiAs(client, { kind: "anonymous" });
    for (const path of ["/v1/c/app/me", "/v1/c/app/kv/shared/k", "/v1/c/app/files"]) {
      const res = await app.request(path);
      expect(res.status).toBe(403);
      expect((await jsonOf<{ code: string }>(res)).code).toBe("STATIC_ONLY");
    }
  });

  it("anonymous on a public_link canvas whose owner lost the publish grant is denied (404)", async () => {
    client = await makeTestDb("sqlite");
    const cv = await seedCanvas("public_link");
    // Simulate an admin revoke that didn't sweep the rung: the per-request capability
    // check (resolveAccessContext → decideCanvasAccess) must still deny (finding #2).
    await usersRepository(client).setPublishPublic(cv.ownerId, false);
    const app = buildApiAs(client, { kind: "anonymous" });
    const res = await app.request("/v1/c/app/me");
    expect(res.status).toBe(404);
  });

  it("guest: me() returns kind:guest + email; KV is attributed to the guest principal", async () => {
    client = await makeTestDb("sqlite");
    const cv = await seedCanvas("specific_people", "g@x.com");
    const principal = {
      kind: "guest" as const,
      id: "guest:inv1",
      inviteId: "inv1",
      canvasId: cv.id,
      email: "g@x.com",
    };
    const app = buildApiAs(client, principal);
    const me = await jsonOf<{ kind: string; email: string }>(await app.request("/v1/c/app/me"));
    expect(me).toMatchObject({ kind: "guest", email: "g@x.com" });

    const set = await app.request("/v1/c/app/kv/user/pref", {
      method: "PUT",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ value: 1 }),
    });
    expect(set.status).toBeLessThan(300);
    // Stored under the guest principal's per-user scope (attribution = guest:<id>).
    expect(await kvRepository(client).get(cv.id, principal.id, "pref")).toEqual({ value: 1 });
  });

  it("guest AI is refused unless the owner opts the canvas in", async () => {
    client = await makeTestDb("sqlite");
    const cv = await seedCanvas("specific_people", "g@x.com");
    const principal = {
      kind: "guest" as const,
      id: "guest:inv1",
      inviteId: "inv1",
      canvasId: cv.id,
      email: "g@x.com",
    };
    const off = await buildApiAs(client, principal, aiConfig).request("/v1/c/app/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(off.status).toBe(403);
    expect((await jsonOf<{ code: string }>(off)).code).toBe("GUEST_AI_DISABLED");

    await canvasesRepository(client).updateSettings(cv.id, { guestAiEnabled: true });
    const on = await buildApiAs(client, principal, aiConfig).request("/v1/c/app/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(on.status).toBe(200);
  });
});

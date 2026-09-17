import { randomBytes } from "node:crypto";
import { createClient } from "@canvas-drop/sdk";
import { type Config, emptyRuntimePolicy, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeProvider } from "../ai/testing.js";
import type { AuditLog } from "../audit/audit-log.js";
import { filesService } from "../canvas/files-service.js";
import { type ConnectionLimits, connectionLimits } from "../connections/limits.js";
import { createSecretCipher } from "../connections/secret-cipher.js";
import { connectionService } from "../connections/service.js";
import type { ConnectionFetchInput, connectionTransport } from "../connections/transport.js";
import type { DbClient } from "../db/factory.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { connectionsRepository } from "../db/repositories/connections.js";
import { filesRepository } from "../db/repositories/files.js";
import { kvRepository } from "../db/repositories/kv.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { canvasApiRoutes } from "./canvas-api.js";

const noopAudit: AuditLog = { recordAudit() {}, flush: async () => {}, record() {} };

describe.each(DIALECTS)("canvas connections runtime [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => client?.close());

  async function fixture(
    options: {
      grant?: boolean;
      backendEnabled?: boolean;
      asViewer?: boolean;
      anonymous?: boolean;
      limits?: ConnectionLimits;
    } = {},
  ) {
    client = await makeTestDb(dialect);
    const encryptionKey = randomBytes(32).toString("base64");
    const config: Config = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_CONNECTIONS_ENCRYPTION_KEY: encryptionKey,
    });
    const users = usersRepository(client);
    const owner = await users.upsert({
      providerSub: "owner",
      email: "owner@example.com",
      name: "Owner",
      isAdmin: false,
    });
    const viewer = await users.upsert({
      providerSub: "viewer",
      email: "viewer@example.com",
      name: "Viewer",
      isAdmin: false,
    });
    const canvases = canvasesRepository(client);
    const canvas = await canvases.create({
      ownerId: owner.id,
      slug: "stocks",
      apiKeyHash: "hash",
      backendEnabled: options.backendEnabled ?? true,
    });
    const service = connectionService({
      repository: connectionsRepository(client),
      canvases,
      cipher: createSecretCipher(encryptionKey),
      audit: noopAudit,
    });
    const profile = await service.create(owner.id, {
      key: "market",
      label: "Market data",
      origin: "https://stocks.example.com",
      allowedMethods: ["GET"],
      protectedHeaders: [{ name: "User-Agent", value: "controlled-stock-agent" }],
    });
    if (options.grant ?? true) await service.attach(owner.id, profile.id, canvas.id);
    const fetch = vi.fn(async (_input: ConnectionFetchInput) => ({
      status: 200,
      headers: new Headers({ "content-type": "application/json", "set-cookie": "blocked=1" }),
      body: new TextEncoder().encode('{"price":42}'),
    }));
    const transport = { fetch } as unknown as ReturnType<typeof connectionTransport>;
    const usage = usageEventsRepository(client);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      if (!options.anonymous) c.set("user", options.asViewer ? viewer : owner);
      else c.set("principal", { kind: "anonymous" });
      c.set("clientIp", "192.0.2.10");
      c.set("orgIds", new Set());
      await next();
    });
    app.route(
      "/v1/c/:slug",
      canvasApiRoutes({
        config,
        canvases,
        publicLinksEnabled: async () => true,
        kv: kvRepository(client),
        files: filesService({ files: filesRepository(client), storage: memStorage() }),
        usage,
        audit: noopAudit,
        aiUsage: aiUsageRepository(client),
        aiProvider: fakeProvider({ deltas: ["ok"] }),
        connections: {
          service,
          transport,
          limits: options.limits ?? connectionLimits(config.connections),
        },
      }),
    );
    return { app, canvas, config, fetch, profile, service, usage, owner };
  }

  it("opens only the approved public connection, never identity or storage", async () => {
    const { app, canvas, fetch, profile, service, owner } = await fixture({ anonymous: true });
    const repo = canvasesRepository(client);
    await repo.updateSettings(canvas.id, { access: "public_link" });
    await repo.updateCapabilities(canvas.id, { connectionsAudience: "viewers" });
    expect((await app.request("/v1/c/stocks/connections/market/quote")).status).toBe(404);
    const unavailable = { invoke: false, methods: [], publicAccess: true };
    for (const key of ["market", "other"]) {
      expect(await (await app.request(`/v1/c/stocks/connection-status/${key}`)).json()).toEqual(
        unavailable,
      );
    }
    await service.setPublicPolicy(owner.id, profile.id, canvas.id, {
      paths: ["/quote"],
      methods: ["GET"],
      requestsPerDay: 2,
    });
    const status = await app.request("/v1/c/stocks/connection-status/market");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ invoke: true, methods: ["GET"], publicAccess: true });
    for (const path of ["/me", "/kv", "/files", "/ai/models", "/realtime", "/authoring"]) {
      expect((await app.request(`/v1/c/stocks${path}`)).status).toBeGreaterThanOrEqual(400);
    }
    for (const path of ["/elsewhere", "/quote?secret=1", "/%71uote", "/quote/extra"]) {
      expect((await app.request(`/v1/c/stocks/connections/market${path}`)).status).toBe(403);
    }
    expect(
      (await app.request("/v1/c/stocks/connections/market/quote", { method: "POST" })).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect((await app.request("/v1/c/stocks/connections/market/quote")).status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ maxRedirects: 0 }));
    expect((await app.request("/v1/c/stocks/connections/market/quote")).status).toBe(200);
    const exhausted = await app.request("/v1/c/stocks/connections/market/quote");
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toMatchObject({ code: "CONNECTION_DAILY_LIMIT" });
    await service.setPublicPolicy(owner.id, profile.id, canvas.id, null);
    expect((await app.request("/v1/c/stocks/connections/market/quote")).status).toBe(404);
    expect(await (await app.request("/v1/c/stocks/connection-status/market")).json()).toEqual(
      unavailable,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses viewer forwarding before transport until the audience is explicitly opened", async () => {
    const { app, canvas, fetch } = await fixture({ asViewer: true });
    const repo = canvasesRepository(client);
    await repo.updateSettings(canvas.id, { access: "whole_org" });
    const denied = await app.request("/v1/c/stocks/connections/market/quote");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fetch).not.toHaveBeenCalled();
    await repo.updateCapabilities(canvas.id, { connectionsAudience: "viewers" });
    expect((await app.request("/v1/c/stocks/connections/market/quote")).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("times out an unfinished public upload, releases its slot and charges the admitted attempt", async () => {
    const { app, canvas, config, profile, service, owner, fetch } = await fixture({
      anonymous: true,
      limits: connectionLimits({
        actorPerMin: 10,
        profilePerMin: 10,
        canvasConcurrency: 1,
        instanceConcurrency: 1,
      }),
    });
    config.connections.timeoutMs = 20;
    await canvasesRepository(client).updateSettings(canvas.id, { access: "public_link" });
    await canvasesRepository(client).updateCapabilities(canvas.id, {
      connectionsAudience: "viewers",
    });
    await service.update(owner.id, profile.id, { allowedMethods: ["POST"] });
    await service.setPublicPolicy(owner.id, profile.id, canvas.id, {
      paths: ["/quote"],
      methods: ["POST"],
      requestsPerDay: 2,
    });
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const response = await app.request(
      new Request("http://localhost/v1/c/stocks/connections/market/quote", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (await app.request("/v1/c/stocks/connections/market/quote", { method: "POST", body: "{}" }))
        .status,
    ).toBe(200);
    expect(
      (await app.request("/v1/c/stocks/connections/market/quote", { method: "POST", body: "{}" }))
        .status,
    ).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps public grants subordinate to lifecycle, password, audience, backend and live profile state", async () => {
    const { app, canvas, fetch, profile, service, owner } = await fixture({ anonymous: true });
    const repo = canvasesRepository(client);
    const call = () => app.request("/v1/c/stocks/connections/market/quote");
    const policy = { paths: ["/quote"], methods: ["GET"], requestsPerDay: 10 };
    await service.setPublicPolicy(owner.id, profile.id, canvas.id, policy);
    expect((await call()).status).toBe(404); // private
    await repo.updateSettings(canvas.id, { access: "public_link" });
    expect((await call()).status).toBe(403); // editors only
    await repo.updateCapabilities(canvas.id, { connectionsAudience: "viewers" });
    await repo.setPassword(canvas.id, "password-hash");
    expect(await (await call()).json()).toMatchObject({ code: "PASSWORD_REQUIRED" });
    await repo.setPassword(canvas.id, null);
    await repo.updateSettings(canvas.id, { sharedExpiresAt: Date.now() - 1000 });
    expect((await call()).status).toBeGreaterThanOrEqual(400);
    await repo.updateSettings(canvas.id, { sharedExpiresAt: null });
    await repo.updateCapabilities(canvas.id, { backendEnabled: false });
    expect((await call()).status).toBe(403);
    await repo.updateCapabilities(canvas.id, { backendEnabled: true });
    const settings = emptyRuntimePolicy();
    settings.connections.market = { audience: "none" };
    await repo.updateCapabilities(canvas.id, {
      runtimePolicy: settings,
      expectedRuntimePolicy: null,
    });
    expect((await call()).status).toBe(403);
    const stored = await repo.findById(canvas.id);
    settings.connections.market = { audience: "viewers" };
    await repo.updateCapabilities(canvas.id, {
      runtimePolicy: settings,
      expectedRuntimePolicy: stored?.runtimePolicy,
    });
    await service.update(owner.id, profile.id, { enabled: false });
    expect((await call()).status).toBe(503);
    await service.update(owner.id, profile.id, { enabled: true });
    expect(
      (
        await app.request("/v1/c/stocks/connections/market/quote", {
          headers: { origin: "https://another.example", "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect((await call()).status).toBe(200);
    await service.detach(owner.id, profile.id, canvas.id);
    expect((await call()).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares public rate limits across spoofed forwarded headers and leaves signed-in status intact", async () => {
    const { app, canvas, profile, service, owner, fetch } = await fixture({
      anonymous: true,
      limits: connectionLimits({
        actorPerMin: 1,
        profilePerMin: 10,
        canvasConcurrency: 5,
        instanceConcurrency: 10,
      }),
    });
    await canvasesRepository(client).updateSettings(canvas.id, { access: "public_link" });
    await canvasesRepository(client).updateCapabilities(canvas.id, {
      connectionsAudience: "viewers",
    });
    await service.setPublicPolicy(owner.id, profile.id, canvas.id, {
      paths: ["/quote"],
      methods: ["GET"],
      requestsPerDay: 10,
    });
    expect(
      (
        await app.request("/v1/c/stocks/connections/market/quote", {
          headers: { "x-forwarded-for": "192.0.2.1" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/v1/c/stocks/connections/market/quote", {
          headers: { "x-forwarded-for": "192.0.2.2" },
        })
      ).status,
    ).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("intersects per-Connection audience and methods with the administrator grant", async () => {
    const { app, canvas, fetch } = await fixture({ asViewer: true });
    const repo = canvasesRepository(client);
    await repo.updateSettings(canvas.id, { access: "whole_org" });
    const policy = emptyRuntimePolicy();
    policy.connections.market = { audience: "viewers", methods: ["GET", "POST"] };
    const stored = await repo.updateCapabilities(canvas.id, {
      runtimePolicy: policy,
      expectedRuntimePolicy: null,
    });
    expect((await app.request("/v1/c/stocks/connections/market/quote")).status).toBe(200);
    expect(
      (await app.request("/v1/c/stocks/connections/market/quote", { method: "POST" })).status,
    ).toBe(405);
    expect(
      (await app.request("/v1/c/stocks/connections/market/quote", { method: "DELETE" })).status,
    ).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await (await app.request("/v1/c/stocks/me")).json()).toMatchObject({
      permissions: { canUseConnections: true },
      resources: { connections: { market: { invoke: true, methods: ["GET"] } } },
    });
    policy.connections.market = { audience: "none" };
    await repo.updateCapabilities(canvas.id, {
      runtimePolicy: policy,
      expectedRuntimePolicy: stored.runtimePolicy,
    });
    expect((await app.request("/v1/c/stocks/connections/market/quote")).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("forwards a granted relative stock path with the protected agent and hardened response", async () => {
    const { app, canvas, fetch, profile, usage } = await fixture();
    const sdk = createClient({
      context: { slug: "stocks", apiBase: "http://canvas-drop.test" },
      fetch: async (input, init) => app.request(input, init),
    });
    expect(await sdk.connections.status("market")).toEqual({
      invoke: true,
      methods: ["GET"],
      publicAccess: false,
    });
    const response = await sdk.connections.fetch("market", "/quote?symbol=ACME", {
      headers: { accept: "application/json", "x-market-tenant": "demo" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ price: 42 });
    expect(response.headers.get("x-canvas-drop-connection-response")).toBe("upstream");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "https://stocks.example.com",
        path: "/quote?symbol=ACME",
        method: "GET",
        callerHeaders: expect.arrayContaining([
          ["accept", "application/json"],
          ["x-market-tenant", "demo"],
        ]),
        protectedHeaders: [["user-agent", "controlled-stock-agent"]],
      }),
    );
    await vi.waitFor(async () => {
      expect((await usage.countByType(canvas.id, null)).connection_op).toBe(1);
    });
    const [event] = await usage.recentConnectionEvents({
      profileId: profile.id,
      sinceMs: 0,
      limit: 1,
      offset: 0,
    });
    expect(event?.origin).toBe("https://stocks.example.com");
    const serializedUsage = JSON.stringify(await usage.countByType(canvas.id, null));
    expect(serializedUsage).not.toContain("symbol");
    expect(serializedUsage).not.toContain("controlled-stock-agent");
  });

  it("ignores the browser's ambient User-Agent when the profile controls the upstream agent", async () => {
    const { app, fetch } = await fixture();
    const response = await app.request("/v1/c/stocks/connections/market/quote", {
      headers: {
        accept: "application/json",
        "user-agent": "ambient-browser-agent",
      },
    });

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    const input = fetch.mock.calls[0]?.[0];
    expect(input?.callerHeaders).toContainEqual(["accept", "application/json"]);
    expect(input?.callerHeaders).not.toContainEqual(["user-agent", "ambient-browser-agent"]);
    expect(input?.protectedHeaders).toEqual([["user-agent", "controlled-stock-agent"]]);
  });

  it("preserves repeated connection-looking segments in the upstream path", async () => {
    const { app, fetch } = await fixture();
    const response = await app.request(
      "/v1/c/stocks/connections/market/archive/connections/market/quote",
    );
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/archive/connections/market/quote" }),
    );
  });

  it("performs no outbound work without a grant or with Backend off", async () => {
    const missing = await fixture({ grant: false });
    expect((await missing.app.request("/v1/c/stocks/connections/market/quote")).status).toBe(404);
    expect(missing.fetch).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      expect((await missing.usage.countByType(missing.canvas.id, null)).connection_op).toBe(1);
    });
    await client.close();

    const backendOff = await fixture({ backendEnabled: false });
    expect((await backendOff.app.request("/v1/c/stocks/connections/market/quote")).status).toBe(
      403,
    );
    expect(backendOff.fetch).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      expect((await backendOff.usage.countByType(backendOff.canvas.id, null)).connection_op).toBe(
        1,
      );
    });
  });

  it("rejects a disallowed method and cross-site request before outbound work", async () => {
    const { app, fetch } = await fixture();
    expect(
      (await app.request("/v1/c/stocks/connections/market/quote", { method: "POST" })).status,
    ).toBe(405);
    expect(
      (
        await app.request("/v1/c/stocks/connections/market/quote", {
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds a streamed request body before outbound work", async () => {
    const { app, config, fetch, profile, service } = await fixture();
    await service.update("admin", profile.id, { allowedMethods: ["POST"] });
    config.connections.maxBodyBytes = 4;
    const response = await app.request("/v1/c/stocks/connections/market/quote", {
      method: "POST",
      body: "12345",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("acquires bounded admission before consuming a request body", async () => {
    const limits = {
      acquire: vi.fn(() => {
        return { release: vi.fn() };
      }),
    } as unknown as ConnectionLimits;
    const { app, profile, service } = await fixture({ limits });
    await service.update("admin", profile.id, { allowedMethods: ["POST"] });
    let releaseBody = () => {};
    const bodyAllowed = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await bodyAllowed;
        controller.enqueue(new TextEncoder().encode("ok"));
        controller.close();
      },
    });
    const pendingResponse = app.request("/v1/c/stocks/connections/market/quote", {
      method: "POST",
      body,
      // Node's fetch Request requires this for a streaming request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await vi.waitFor(() => expect(limits.acquire).toHaveBeenCalledOnce());
    releaseBody();
    const response = await pendingResponse;
    expect(response.status).toBe(200);
  });

  it("refuses public-link viewers without an explicit public grant", async () => {
    const { app, canvas, fetch } = await fixture({ asViewer: true });
    await canvasesRepository(client).updateSettings(canvas.id, { access: "public_link" });
    const response = await app.request("/v1/c/stocks/connections/market/quote");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks the next call immediately after detach or disable", async () => {
    const { app, fetch, profile, service } = await fixture();
    expect((await app.request("/v1/c/stocks/connections/market/quote")).status).toBe(200);
    await service.detach(
      "admin",
      profile.id,
      (await canvasesRepository(client).findBySlug("stocks"))?.id ?? "",
    );
    expect((await app.request("/v1/c/stocks/connections/market/quote")).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

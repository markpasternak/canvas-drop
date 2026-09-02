import { randomBytes } from "node:crypto";
import { createClient } from "@canvas-drop/sdk";
import { type Config, loadConfig } from "@canvas-drop/shared";
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
      c.set("user", options.asViewer ? viewer : owner);
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
    return { app, canvas, config, fetch, profile, service, usage };
  }

  it("forwards a granted relative stock path with the protected agent and hardened response", async () => {
    const { app, canvas, fetch, profile, usage } = await fixture();
    const sdk = createClient({
      context: { slug: "stocks", apiBase: "http://canvas-drop.test" },
      fetch: async (input, init) => app.request(input, init),
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

  it("keeps public-link viewers static-only even when the profile is granted", async () => {
    const { app, canvas, fetch } = await fixture({ asViewer: true });
    await canvasesRepository(client).updateSettings(canvas.id, { access: "public_link" });
    const response = await app.request("/v1/c/stocks/connections/market/quote");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "STATIC_ONLY" });
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

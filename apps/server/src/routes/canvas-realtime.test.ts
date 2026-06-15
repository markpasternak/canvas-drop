import { type Config, loadConfig } from "@canvas-drop/shared";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fakeProvider } from "../ai/testing.js";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
import { devStrategy } from "../auth/dev.js";
import { sessionService } from "../auth/session.js";
import type { DbClient } from "../db/factory.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import type { AppEnv } from "../http/types.js";
import { createHub, type RealtimeHub } from "../realtime/hub.js";
import { memStorage } from "../storage/mem.js";
import { canvasApiRoutes } from "./canvas-api.js";

const silent = pino({ level: "silent" });
const devConfig: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_DEV_USER_EMAIL: "dev@example.com",
  CANVAS_DROP_ADMIN_EMAILS: "dev@example.com",
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

function listen(
  app: Hono<AppEnv>,
  inject: (server: ReturnType<typeof serve>) => void,
): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    let server: ReturnType<typeof serve>;
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };

    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      server.off("error", onError);
      resolve({
        port: info.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    server.once("error", onError);
    inject(server);
  });
}

/** Full app (real auth gateway, dev mode) — for handshake-auth assertions. */
async function startFullApp(client: DbClient): Promise<ServerHandle & { hub: RealtimeHub }> {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  const hub = createHub({ config: devConfig, resolveCanvas: (id) => canvases.findById(id) });
  let inject!: (server: ReturnType<typeof serve>) => void;
  const app = buildApp({
    config: devConfig,
    db: client,
    rootLogger: silent,
    strategy: devStrategy(devConfig),
    users: usersRepository(client),
    canvases,
    versions,
    drafts,
    storage,
    engine: deployEngine({ config: devConfig, canvases, versions, drafts, storage, log: silent }),
    audit: createAuditLog(auditRepository(client), silent),
    sessionSvc: sessionService(devConfig, sessionsRepository(client)),
    peerIp: () => "127.0.0.1",
    hub,
    registerWebSocket: (honoApp) => {
      const nodeWs = createNodeWebSocket({ app: honoApp });
      inject = nodeWs.injectWebSocket as typeof inject;
      return nodeWs.upgradeWebSocket;
    },
  });
  const handle = await listen(app, inject);
  return { ...handle, hub };
}

/**
 * Minimal app with an injectable identity (x-test-user header) — for revoke /
 * isolation / presence assertions where we need a NON-admin viewer.
 */
async function startInjectedApp(client: DbClient): Promise<ServerHandle & { hub: RealtimeHub }> {
  const canvases = canvasesRepository(client);
  const hub = createHub({ config: devConfig, resolveCanvas: (id) => canvases.findById(id) });
  const app = new Hono<AppEnv>();
  const nodeWs = createNodeWebSocket({ app });
  app.use("*", async (c, next) => {
    const id = c.req.header("x-test-user") ?? "admin";
    c.set("user", {
      id,
      name: id,
      email: `${id}@example.com`,
      avatarUrl: null,
      isAdmin: id === "admin",
    } as never);
    await next();
  });
  app.route(
    "/v1/c/:slug",
    canvasApiRoutes({
      config: devConfig,
      canvases,
      // biome-ignore lint/suspicious/noExplicitAny: kv/files unused in realtime tests
      kv: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: kv/files unused in realtime tests
      files: {} as any,
      usage: usageEventsRepository(client),
      aiUsage: aiUsageRepository(client),
      aiProvider: fakeProvider({ deltas: [] }),
      realtime: { hub, upgradeWebSocket: nodeWs.upgradeWebSocket },
    }),
  );
  const handle = await listen(app, nodeWs.injectWebSocket);
  return { ...handle, hub };
}

interface Client {
  sock: WebSocket;
  messages: Array<Record<string, unknown>>;
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  send(obj: unknown): void;
  waitFor(
    pred: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ): Promise<Record<string, unknown>>;
}

function connect(port: number, slug: string, headers: Record<string, string> = {}): Client {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/v1/c/${slug}/realtime`, { headers });
  const messages: Array<Record<string, unknown>> = [];
  sock.on("message", (d) => messages.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number; reason: string }>((r) =>
    sock.on("close", (code, reason) => r({ code, reason: reason?.toString() ?? "" })),
  );
  const opened = new Promise<void>((resolve, reject) => {
    sock.once("open", () => resolve());
    sock.once("unexpected-response", (_req, res) =>
      reject(Object.assign(new Error("handshake refused"), { status: res.statusCode })),
    );
    sock.once("error", (e) => reject(e));
  });
  return {
    sock,
    messages,
    opened,
    closed,
    send: (obj) => sock.send(JSON.stringify(obj)),
    async waitFor(pred, ms = 2000) {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const m = messages.find(pred);
        if (m) return m;
        await delay(15);
      }
      throw new Error("timeout waiting for message");
    },
  };
}

async function seedCanvas(
  client: DbClient,
  opts: {
    ownerId?: string;
    shared?: boolean;
    backendEnabled?: boolean;
    capRealtime?: boolean;
    slug?: string;
  } = {},
) {
  const owner = await usersRepository(client).upsert({
    providerSub: `owner-${opts.slug ?? "app"}`,
    email: `owner-${opts.slug ?? "app"}@example.com`,
    name: "Owner",
    isAdmin: false,
  });
  const cv = await canvasesRepository(client).create({
    ownerId: opts.ownerId ?? owner.id,
    slug: opts.slug ?? "app",
    apiKeyHash: `h-${opts.slug ?? "app"}`,
    backendEnabled: opts.backendEnabled ?? true,
  });
  let updated = cv;
  if (opts.shared)
    updated = await canvasesRepository(client).updateSettings(cv.id, { access: "whole_org" });
  if (opts.capRealtime === false) {
    updated = await canvasesRepository(client).updateCapabilities(cv.id, { realtime: false });
  }
  return { owner, cv: updated };
}

describe("realtime WebSocket route", () => {
  let client: DbClient;
  let server: (ServerHandle & { hub: RealtimeHub }) | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets) s.close();
    sockets.length = 0;
    await server?.close();
    server = undefined;
    await client?.close();
  });
  const track = (c: Client) => {
    sockets.push(c.sock);
    return c;
  };

  it("authenticated handshake upgrades (101) and the dev user can publish/subscribe", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, { slug: "app" });
    server = await startFullApp(client);
    const a = track(connect(server.port, "app"));
    await a.opened; // 101 — upgrade traversed gateway + resolve + isolation
    a.send({ type: "subscribe", channel: "room" });
    await a.waitFor((m) => m.type === "subscribed");
    a.send({ type: "publish", channel: "room", event: "ping", data: 1 });
    const msg = await a.waitFor((m) => m.type === "message");
    expect(msg).toMatchObject({ event: "ping", data: 1 });
  });

  it("refuses the upgrade (no 101) for a non-existent canvas — middleware denies pre-upgrade", async () => {
    client = await makeTestDb("sqlite");
    server = await startFullApp(client);
    const c = track(connect(server.port, "ghost"));
    await expect(c.opened).rejects.toMatchObject({ status: 404 });
  });

  it("refuses the upgrade (no 101) for an owner-only canvas hit by a non-owner — authorization denied pre-upgrade", async () => {
    client = await makeTestDb("sqlite");
    // Owner-only (not shared) canvas; a non-owner viewer must be denied the upgrade
    // by decideCanvasAccess in the resolve middleware, before any 101.
    await seedCanvas(client, { slug: "app", shared: false });
    server = await startInjectedApp(client);
    const c = track(connect(server.port, "app", { "x-test-user": "viewer" }));
    await expect(c.opened).rejects.toMatchObject({ status: 404 }); // owner_only → 404
  });

  it("capability-off: upgrades then closes 4403 with a CAPABILITY_DISABLED frame", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, { slug: "app", capRealtime: false });
    server = await startFullApp(client);
    const c = track(connect(server.port, "app"));
    await c.opened; // accept-then-close (capability is a flag, not a security boundary)
    const closed = await c.closed;
    expect(closed.code).toBe(4403);
    expect(c.messages.some((m) => m.code === "CAPABILITY_DISABLED")).toBe(true);
  });

  it("isolates canvases — a publish in canvas A never reaches a socket on canvas B", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, { slug: "a" });
    await seedCanvas(client, { slug: "b" });
    server = await startInjectedApp(client);
    const a = track(connect(server.port, "a")); // admin (default header)
    const b = track(connect(server.port, "b"));
    await Promise.all([a.opened, b.opened]);
    a.send({ type: "subscribe", channel: "room" });
    b.send({ type: "subscribe", channel: "room" });
    await a.waitFor((m) => m.type === "subscribed");
    await b.waitFor((m) => m.type === "subscribed");
    a.send({ type: "publish", channel: "room", event: "x", data: 1 });
    await a.waitFor((m) => m.type === "message"); // A sees its own publish
    await delay(100);
    expect(b.messages.some((m) => m.type === "message")).toBe(false); // B never does
  });

  it("revoke-drops-socket: un-sharing a canvas closes a non-owner socket (4401)", async () => {
    client = await makeTestDb("sqlite");
    const { cv } = await seedCanvas(client, { slug: "app", shared: true });
    server = await startInjectedApp(client);
    const viewer = track(connect(server.port, "app", { "x-test-user": "viewer" }));
    await viewer.opened; // shared → allowed
    viewer.send({ type: "subscribe", channel: "room" });
    await viewer.waitFor((m) => m.type === "subscribed");

    // Owner un-shares; the management hook calls revalidateCanvas.
    await canvasesRepository(client).updateSettings(cv.id, { access: "private" });
    await server.hub.revalidateCanvas(cv.id);

    const closed = await viewer.closed;
    expect(closed.code).toBe(4401);
  });

  it("presence: a second subscriber triggers a join broadcast and shows in presence", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, { slug: "app", shared: true });
    server = await startInjectedApp(client);
    const a = track(connect(server.port, "app", { "x-test-user": "alice" }));
    const b = track(connect(server.port, "app", { "x-test-user": "bob" }));
    await Promise.all([a.opened, b.opened]);
    a.send({ type: "subscribe", channel: "room" });
    await a.waitFor((m) => m.type === "subscribed");
    b.send({ type: "subscribe", channel: "room" });
    await b.waitFor((m) => m.type === "subscribed");
    // alice sees bob join
    const join = await a.waitFor((m) => m.type === "join");
    expect((join.user as { id: string }).id).toBe("bob");
    // bob's presence snapshot lists both
    const presence = b.messages.find((m) => m.type === "presence");
    expect((presence?.users as Array<{ id: string }>).map((u) => u.id).sort()).toEqual([
      "alice",
      "bob",
    ]);
  });
});

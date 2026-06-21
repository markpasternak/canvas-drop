import { Buffer } from "node:buffer";
import { type Config, loadConfig } from "@canvas-drop/shared";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zipSync } from "fflate";
import { pino } from "pino";
import type { ModelProvider } from "../ai/provider.js";
import { fakeProvider } from "../ai/testing.js";
import { buildApp } from "../app.js";
import { type AuditLog, createAuditLog } from "../audit/audit-log.js";
import { guestService } from "../auth/guest.js";
import { sessionService } from "../auth/session.js";
import type { AuthStrategy } from "../auth/strategy.js";
import { cloneService } from "../canvas/clone-service.js";
import type { DbClient } from "../db/factory.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { filesRepository } from "../db/repositories/files.js";
import { guestRepository } from "../db/repositories/guest.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { screenshotsRepository } from "../db/repositories/screenshots.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { uploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { type DeployEngine, deployEngine } from "../deploy/engine.js";
import { draftService } from "../draft/service.js";
import type { EmailMessage, Mailer } from "../email/mailer.js";
import { buildMcpServer } from "../mcp/server.js";
import { createHub, type RealtimeHub } from "../realtime/hub.js";
import { memStorage } from "../storage/mem.js";
import { teamsService } from "../teams/service.js";
import { uploadService } from "../upload/service.js";

/**
 * Shared wiring for the capability acceptance scenarios
 * (`capability-scenarios.test.ts`). Every scenario runs against the REAL composed
 * app (`buildApp` — the same role-routed Hono app `index.ts` serves), so the
 * gateway → identity → access → primitive → audit chain is exercised together,
 * not a hand-rolled sub-app. See `docs/qa/2026-06-20-capability-scenarios.md`.
 */

const silent = pino({ level: "silent" });

export const DOMAIN = "example.com";
export const OWNER = `owner@${DOMAIN}`;
export const MEMBER = `member@${DOMAIN}`;
export const OTHER = `other@${DOMAIN}`;
export const ADMIN = `admin@${DOMAIN}`;
/** A non-member email → invited as a guest (outside the org domain). */
export const GUEST_EMAIL = "guest@partner.test";
/** An allowlisted, priced model id (has a pricing entry, so it passes the AI gate). */
export const AI_MODEL = "claude-haiku-4-5";

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export const zip = (files: Record<string, string>): Buffer =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc(v)]))));

export async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Read an SSE body into its decoded `data:` JSON frames. */
export async function sseFrames<T = Record<string, unknown>>(res: Response): Promise<T[]> {
  const body = await res.text();
  const frames: T[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const json = trimmed.slice("data:".length).trim();
      if (json) frames.push(JSON.parse(json) as T);
    }
  }
  return frames;
}

/**
 * Auth strategy that resolves identity from an `x-test-user` header — stands in
 * for the upstream IAP/OIDC, letting a scenario act as several distinct org
 * members through the *real* gateway (identity is still server-resolved into the
 * `users` row, never read from a client-trusted body). Falls back to the owner.
 */
function headerStrategy(): AuthStrategy {
  return {
    async resolveIdentity(c) {
      const email = c.req.header("x-test-user") ?? OWNER;
      return { sub: `dev:${email}`, email, name: email.split("@")[0] };
    },
  };
}

export interface CaptureMailer extends Mailer {
  readonly sent: EmailMessage[];
  /** The most recent guest magic-link token sent to `email`, parsed from the body. */
  tokenFor(email: string): string | null;
}

/** A mailer that records every message so a test can read back the invite link. */
export function captureMailer(): CaptureMailer {
  const sent: EmailMessage[] = [];
  return {
    canSend: true,
    sent,
    async send(msg) {
      sent.push(msg);
      return { ok: true };
    },
    tokenFor(email) {
      const msg = [...sent].reverse().find((m) => m.to === email);
      if (!msg) return null;
      const match = /\/guest\/([A-Za-z0-9_.-]+)/.exec(msg.text);
      return match?.[1] ?? null;
    },
  };
}

export interface ScenarioRepos {
  users: ReturnType<typeof usersRepository>;
  canvases: ReturnType<typeof canvasesRepository>;
  versions: ReturnType<typeof versionsRepository>;
  drafts: ReturnType<typeof draftsRepository>;
  files: ReturnType<typeof filesRepository>;
  usage: ReturnType<typeof usageEventsRepository>;
  aiUsage: ReturnType<typeof aiUsageRepository>;
  screenshots: ReturnType<typeof screenshotsRepository>;
  uploadSessions: ReturnType<typeof uploadSessionsRepository>;
  guests: ReturnType<typeof guestRepository>;
}

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

export interface Harness {
  app: ReturnType<typeof buildApp>;
  config: Config;
  storage: ReturnType<typeof memStorage>;
  mailer: CaptureMailer;
  hub: RealtimeHub;
  engine: DeployEngine;
  audit: AuditLog;
  repos: ScenarioRepos;
  client: DbClient;
  baseHost: string;
  /** Header set for a request acting as `email` (null = no org identity, e.g. a guest cookie). */
  headers(email: string | null, extra?: Record<string, string>): Record<string, string>;
  /** Plain authenticated GET (reads; no same-origin marker needed). */
  GET(email: string | null, path: string, extra?: Record<string, string>): Promise<Response>;
  /** Same-origin JSON mutation (POST/PUT/PATCH/DELETE) acting as `email`. */
  SEND(
    email: string | null,
    method: string,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<Response>;
  /** Boot a real listening server (for realtime/WS scenarios); injects the WS upgrade handler. */
  listen(): Promise<ServerHandle>;
}

export function makeHarness(
  client: DbClient,
  opts: { config?: Config; aiProvider?: ModelProvider } = {},
): Harness {
  const config = opts.config ?? scenarioConfig();
  const users = usersRepository(client);
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  const audit = createAuditLog(auditRepository(client), silent);
  const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
  const hub = createHub({
    config,
    resolveCanvas: (id) => canvases.findById(id),
    isUserActive: async (id) => {
      const u = await users.findById(id);
      return !!u && !u.isBlocked;
    },
    isPrincipalAllowed: (canvasId, principal) => canvases.isPrincipalAllowed(canvasId, principal),
  });
  const mailer = captureMailer();

  let injectWebSocket: ((server: ReturnType<typeof serve>) => void) | undefined;
  const app = buildApp({
    config,
    db: client,
    rootLogger: silent,
    strategy: headerStrategy(),
    users,
    canvases,
    versions,
    drafts,
    storage,
    engine,
    audit,
    sessionSvc: sessionService(config, sessionsRepository(client)),
    guests: guestService(config, guestRepository(client)),
    mailer,
    aiProvider:
      opts.aiProvider ??
      fakeProvider({ deltas: ["Hello, ", "world."], usage: { inputTokens: 12, outputTokens: 8 } }),
    hub,
    peerIp: () => "127.0.0.1",
    registerWebSocket: (honoApp) => {
      const nodeWs = createNodeWebSocket({ app: honoApp, baseUrl: config.baseUrl });
      injectWebSocket = nodeWs.injectWebSocket as typeof injectWebSocket;
      return nodeWs.upgradeWebSocket;
    },
  });

  const baseHost = new URL(config.baseUrl).host;
  const headers = (email: string | null, extra: Record<string, string> = {}) => {
    const h: Record<string, string> = { host: baseHost, ...extra };
    if (email) h["x-test-user"] = email;
    return h;
  };

  return {
    app,
    config,
    storage,
    mailer,
    hub,
    engine,
    audit,
    client,
    baseHost,
    headers,
    repos: {
      users,
      canvases,
      versions,
      drafts,
      files: filesRepository(client),
      usage: usageEventsRepository(client),
      aiUsage: aiUsageRepository(client),
      screenshots: screenshotsRepository(client),
      uploadSessions: uploadSessionsRepository(client),
      guests: guestRepository(client),
    },
    GET: (email, path, extra) =>
      Promise.resolve(app.request(path, { headers: headers(email, extra) })),
    SEND: (email, method, path, body, extra) =>
      Promise.resolve(
        app.request(path, {
          method,
          headers: headers(email, {
            "Sec-Fetch-Site": "same-origin",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...extra,
          }),
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      ),
    listen: () =>
      new Promise<ServerHandle>((resolve, reject) => {
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
        injectWebSocket?.(server);
      }),
  };
}

/** Standard scenario config — dev auth (header strategy), AI + realtime enabled. */
export function scenarioConfig(extra: Record<string, string> = {}): Config {
  return loadConfig({
    CANVAS_DROP_AUTH_MODE: "dev",
    CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: DOMAIN,
    CANVAS_DROP_ADMIN_EMAILS: ADMIN,
    CANVAS_DROP_AI_API_KEY: "sk-test-not-a-real-key",
    CANVAS_DROP_AI_MODELS: AI_MODEL,
    CANVAS_DROP_AI_USER_DAILY_USD: "5",
    CANVAS_DROP_AI_CANVAS_MONTHLY_USD: "50",
    ...extra,
  });
}

/**
 * Connect a real in-process MCP client bound to `caller`, sharing the harness's
 * DB + storage + engine so what an agent publishes over MCP is the same canvas
 * the HTTP app serves (the agent-native parity rule). Returns the connected client.
 */
export async function connectMcp(
  h: Harness,
  caller: { userId: string; orgIds?: Set<string>; tenancyActive?: boolean },
): Promise<McpClient> {
  const { config, repos, storage, engine, audit } = h;
  const teams = teamsRepository(h.client);
  const orgMembers = orgMembersRepository(h.client);
  const server = buildMcpServer(
    {
      config,
      users: repos.users,
      orgs: orgsRepository(h.client),
      orgMembers,
      teams,
      teamsService: teamsService({ teams, orgMembers, users: repos.users, audit }),
      canvases: repos.canvases,
      versions: repos.versions,
      engine,
      upload: uploadService({
        config,
        canvases: repos.canvases,
        users: repos.users,
        uploadSessions: repos.uploadSessions,
        storage,
        engine,
      }),
      storage,
      clone: cloneService({
        canvases: repos.canvases,
        versions: repos.versions,
        drafts: repos.drafts,
        storage,
      }),
      drafts: draftService({
        config,
        canvases: repos.canvases,
        versions: repos.versions,
        drafts: repos.drafts,
        storage,
        audit,
        log: silent,
      }),
      usage: repos.usage,
      files: repos.files,
      aiUsage: repos.aiUsage,
      audit,
      log: silent,
      screenshots: repos.screenshots,
      screenshotsEnabled: () => Promise.resolve(false),
    },
    {
      userId: caller.userId,
      orgIds: caller.orgIds ?? new Set<string>(),
      tenancyActive: caller.tenancyActive ?? false,
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new McpClient({ name: "scenario", version: "1" });
  await mcp.connect(clientTransport);
  return mcp;
}

// biome-ignore lint/suspicious/noExplicitAny: MCP tool results are JSON text payloads.
export function mcpPayload(result: any): any {
  return JSON.parse(result.content[0].text);
}

// biome-ignore lint/suspicious/noExplicitAny: MCP tool results are JSON text payloads.
export function mcpIsError(result: any): boolean {
  return result.isError === true;
}

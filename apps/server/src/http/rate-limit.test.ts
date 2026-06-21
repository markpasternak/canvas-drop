import { type Config, loadConfig } from "@canvas-drop/shared";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
import { devStrategy } from "../auth/dev.js";
import { sessionService } from "../auth/session.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { memStorage } from "../storage/mem.js";
import { HOUR_MS, inProcessRateLimitStore, takeToken } from "./rate-limit.js";

// --- takeToken windowMs (plan 003 phase 3 — the invite limiter uses an hourly window) ---

describe("takeToken windowMs", () => {
  it("defaults to a per-minute window; an explicit hourly window holds across minutes", () => {
    let now = 1_000_000;
    const store = inProcessRateLimitStore(() => now);
    // Hourly window: 2 allowed, the 3rd blocked even after a minute passes.
    expect(takeToken(store, "invite:u", 2, HOUR_MS).allowed).toBe(true);
    expect(takeToken(store, "invite:u", 2, HOUR_MS).allowed).toBe(true);
    now += 61_000; // a minute later — a per-minute window would have reset
    expect(takeToken(store, "invite:u", 2, HOUR_MS).allowed).toBe(false);
    now += HOUR_MS; // past the hour — now it resets
    expect(takeToken(store, "invite:u", 2, HOUR_MS).allowed).toBe(true);
  });
});

// --- The in-process store (injected clock) ---

describe("inProcessRateLimitStore", () => {
  it("allows up to the limit, blocks the next, resets after the window", () => {
    let now = 1_000_000;
    const store = inProcessRateLimitStore(() => now);
    const k = "k";
    expect(store.hit(k, 2, 60_000).allowed).toBe(true);
    expect(store.hit(k, 2, 60_000).allowed).toBe(true);
    const blocked = store.hit(k, 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    // Advance past the window → fresh budget.
    now += 60_001;
    expect(store.hit(k, 2, 60_000).allowed).toBe(true);
  });

  it("keeps separate buckets per key", () => {
    let now = 0;
    const store = inProcessRateLimitStore(() => now);
    expect(store.hit("a", 1, 1000).allowed).toBe(true);
    expect(store.hit("a", 1, 1000).allowed).toBe(false);
    expect(store.hit("b", 1, 1000).allowed).toBe(true); // independent
    now += 1;
  });

  it("at the key cap with nothing expired, fails OPEN without wiping a live bucket", () => {
    const now = 1_000_000; // frozen clock — nothing ever expires
    const store = inProcessRateLimitStore(() => now);
    store.hit("victim", 2, 60_000); // victim count = 1
    // Fill past the 100k cap with live buckets.
    for (let i = 0; i < 100_001; i++) store.hit(`k${i}`, 10, 60_000);
    // A new key beyond the cap is allowed (fail-open) — never evicts a live bucket.
    expect(store.hit("new-overflow", 1, 60_000).allowed).toBe(true);
    // The victim's counter SURVIVED (was not reset): count 2 ok, count 3 blocked.
    expect(store.hit("victim", 2, 60_000).allowed).toBe(true); // count 2
    expect(store.hit("victim", 2, 60_000).allowed).toBe(false); // count 3 → blocked
  });
});

// --- The middleware + out-of-band throttles, end-to-end through buildApp ---

const silent = pino({ level: "silent" });

/** Config with tiny limits so a breach happens in a couple of requests. */
function lowLimitConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    CANVAS_DROP_AUTH_MODE: "dev",
    CANVAS_DROP_DEV_USER_EMAIL: "mark@example.com",
    CANVAS_DROP_ADMIN_EMAILS: "mark@example.com",
    CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN: "2",
    CANVAS_DROP_RATELIMIT_MANAGEMENT_PER_MIN: "2",
    CANVAS_DROP_RATELIMIT_AI_PER_MIN: "2",
    CANVAS_DROP_RATELIMIT_LOGIN_PER_MIN: "2",
    ...overrides,
  });
}

function app(client: DbClient, config: Config, peerIp = () => "127.0.0.1") {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  return buildApp({
    config,
    db: client,
    rootLogger: silent,
    strategy: devStrategy(config),
    users: usersRepository(client),
    canvases,
    versions,
    drafts,
    storage,
    engine: deployEngine({ config, canvases, versions, drafts, storage, log: silent }),
    audit: createAuditLog(auditRepository(client), silent),
    sessionSvc: sessionService(config, sessionsRepository(client)),
    peerIp,
  });
}

const host = { host: "localhost:3000" };

describe("rate limiting (middleware + out-of-band)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** Seed a backend-enabled canvas owned by the dev user. */
  async function seedCanvas(client: DbClient, slug = "app") {
    // Match the dev strategy's identity (sub `dev:<email>`) so the canvas owner IS
    // the gateway-resolved user — a different sub with the same email would 500 on
    // the unique-email index when the gateway upserts on first request.
    const owner = await usersRepository(client).upsert({
      providerSub: "dev:mark@example.com",
      email: "mark@example.com",
      name: "Mark",
      isAdmin: true,
    });
    return canvasesRepository(client).create({
      ownerId: owner.id,
      slug,
      apiKeyHash: `h-${slug}`,
      backendEnabled: true,
    });
  }

  it("runtime breach → 429 { code: RATE_LIMITED } (mandated)", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, lowLimitConfig());
    await seedCanvas(client);
    expect((await a.request("/v1/c/app/me", { headers: host })).status).toBe(200);
    expect((await a.request("/v1/c/app/me", { headers: host })).status).toBe(200);
    const res = await a.request("/v1/c/app/me", { headers: host });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe("RATE_LIMITED");
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("management breach → 429 { error: rate_limited } (mandated)", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, lowLimitConfig());
    expect((await a.request("/api/canvases", { headers: host })).status).toBe(200);
    expect((await a.request("/api/canvases", { headers: host })).status).toBe(200);
    const res = await a.request("/api/canvases", { headers: host });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
  });

  it("browser management breach → designed 429 HTML with rate-limit headers", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, lowLimitConfig());
    expect((await a.request("/api/canvases", { headers: host })).status).toBe(200);
    expect((await a.request("/api/canvases", { headers: host })).status).toBe(200);
    const res = await a.request("/api/canvases", {
      headers: { ...host, accept: "text/html" },
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(res.headers.get("x-ratelimit-limit")).toBe("2");
    expect(await res.text()).toContain("Too many requests");
  });

  it("static content + healthz are NOT throttled (not API classes)", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, lowLimitConfig());
    for (let i = 0; i < 5; i++) {
      expect((await a.request("/healthz")).status).toBe(200);
    }
    // A missing canvas content path 404s but is never 429 (content is not throttled).
    for (let i = 0; i < 5; i++) {
      const res = await a.request("/c/ghost/index.html", { headers: host });
      expect(res.status).not.toBe(429);
    }
  });

  it("the master flag disables all throttling", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, lowLimitConfig({ CANVAS_DROP_RATELIMIT_ENABLED: "false" }));
    for (let i = 0; i < 6; i++) {
      expect((await a.request("/api/canvases", { headers: host })).status).toBe(200);
    }
  });

  it("login is throttled per-IP, pre-gateway (10/min default; 2 here)", async () => {
    client = await makeTestDb("sqlite");
    // oidc-less dev mode has no /auth/login handler, but the throttle runs first;
    // before the limit it falls through (404), past it returns 429.
    const a = app(client, lowLimitConfig());
    await a.request("/auth/login", { headers: host });
    await a.request("/auth/login", { headers: host });
    const res = await a.request("/auth/login", { headers: host });
    expect(res.status).toBe(429);
  });

  it("AI sub-class throttles M9's /v1/c/:slug/ai/* (10/min/user; 2 here)", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, lowLimitConfig()); // aiPerMin = 2
    await seedCanvas(client);
    // The rate-limit middleware runs BEFORE the AI handler, so the 3rd request
    // 429s regardless of the handler outcome — proving the broad classifier
    // covers M9's real AI route via the stricter ai sub-class.
    await a.request("/v1/c/app/ai/chat", { method: "POST", headers: host });
    await a.request("/v1/c/app/ai/chat", { method: "POST", headers: host });
    const res = await a.request("/v1/c/app/ai/chat", { method: "POST", headers: host });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe("RATE_LIMITED");
  });

  it("M9's realtime handshake /v1/c/:slug/realtime counts against the canvas class", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, lowLimitConfig()); // canvasApiPerMin = 2
    await seedCanvas(client);
    // The WS upgrade is an HTTP GET under /v1/c/:slug/* (not /ai/), so it
    // classifies as the canvas class and shares that 60s bucket — the broad
    // middleware runs on the upgrade request before any handler. The 3rd hit 429s.
    await a.request("/v1/c/app/realtime", { headers: host });
    await a.request("/v1/c/app/realtime", { headers: host });
    const res = await a.request("/v1/c/app/realtime", { headers: host });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe("RATE_LIMITED");
  });

  it("Bearer deploy throttled per-canvas with a valid key; no key → 401 (not 429)", async () => {
    client = await makeTestDb("sqlite");
    const a = app(client, lowLimitConfig({ CANVAS_DROP_RATELIMIT_DEPLOY_PER_MIN: "1" }));
    // Create via the management API to obtain a real Bearer key.
    const created = (await (
      await a.request("/api/canvases", {
        method: "POST",
        headers: { ...host, "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: "{}",
      })
    ).json()) as { id: string; apiKey: string };
    const bearer = { Authorization: `Bearer ${created.apiKey}` };

    // No key → 401 (key validation runs before the throttle), never 429.
    const noKey = await a.request(`/v1/canvases/${created.id}/deploy`, {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(noKey.status).toBe(401);

    // 1st keyed deploy passes the throttle (then fails on the junk zip — 400);
    // 2nd exceeds the 1/min deploy limit → 429.
    const first = await a.request(`/v1/canvases/${created.id}/deploy`, {
      method: "PUT",
      headers: bearer,
      body: new Uint8Array([1, 2, 3]),
    });
    expect(first.status).not.toBe(429);
    const second = await a.request(`/v1/canvases/${created.id}/deploy`, {
      method: "PUT",
      headers: bearer,
      body: new Uint8Array([1, 2, 3]),
    });
    expect(second.status).toBe(429);
  });
});

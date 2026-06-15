import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { type AuditLog, createAuditLog } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { makeTestDb } from "../db/testing.js";
import { inProcessRateLimitStore } from "../http/rate-limit.js";
import type { AppEnv } from "../http/types.js";
import { hashPassword } from "./password.js";
import { GATE_COOKIE, gatePage, passwordGate, signGrant, verifyGrant } from "./password-gate.js";

const silent = pino({ level: "silent" });
const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

function canvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    id: "cvA",
    slug: "s",
    title: "Secret",
    description: null,
    ownerId: "owner",
    access: "whole_org",
    sharedExpiresAt: null,
    galleryListed: false,
    galleryTemplatable: false,
    gallerySummary: null,
    galleryTags: null,
    galleryPublishedAt: null,
    passwordHash: null,
    passwordVersion: 1,
    spaFallback: false,
    backendEnabled: false,
    capKv: true,
    capFiles: true,
    capAi: true,
    capRealtime: true,
    apiKeyHash: "h",
    status: "active",
    disabledReason: null,
    currentVersionId: "v1",
    clonedFromCanvasId: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  };
}

function buildApp(cv: Canvas, audit: AuditLog) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "viewer" } as never);
    c.set("clientIp", "127.0.0.1");
    c.set("canvas", cv);
    c.set("needsPasswordGate", cv.passwordHash !== null);
    await next();
  });
  app.use("*", passwordGate({ config, audit }));
  app.all("/c/:slug/*", (c) => c.text("CANVAS CONTENT"));
  app.all("*", (c) => c.text("CANVAS CONTENT"));
  return app;
}

function gateCookieFrom(res: Response): string | undefined {
  for (const sc of res.headers.getSetCookie()) {
    const m = new RegExp(`${GATE_COOKIE}=([^;]+)`).exec(sc);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return undefined;
}

describe("passwordGate", () => {
  let client: DbClient;
  let audit: AuditLog;
  afterEach(async () => {
    await client?.close();
  });
  async function mkAudit() {
    client = await makeTestDb("sqlite");
    audit = createAuditLog(auditRepository(client), silent);
    return audit;
  }

  it("wrong password → 401, no cookie, gate re-shown, failure audited", async () => {
    const cv = canvas({ passwordHash: await hashPassword("right") });
    const app = buildApp(cv, await mkAudit());
    const res = await app.request("/c/s/index.html", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=wrong",
    });
    expect(res.status).toBe(401);
    expect(gateCookieFrom(res)).toBeUndefined();
    expect(await res.text()).toContain("Incorrect password");
    await audit.flush();
    const rows = await auditRepository(client).recent();
    expect(rows[0]).toMatchObject({ action: "password_attempt" });
    expect(rows[0].meta).toMatchObject({ success: false });
  });

  it("correct password → sets gate cookie and redirects past the gate", async () => {
    const cv = canvas({ passwordHash: await hashPassword("right") });
    const app = buildApp(cv, await mkAudit());
    const res = await app.request("/c/s/index.html", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=right",
    });
    expect(res.status).toBe(303);
    const cookie = gateCookieFrom(res);
    expect(cookie).toBeTruthy();
    // a follow-up GET carrying the cookie passes the gate
    const ok = await app.request("/c/s/index.html", {
      headers: { Cookie: `${GATE_COOKIE}=${cookie}` },
    });
    expect(await ok.text()).toBe("CANVAS CONTENT");
  });

  it("no password set → gate is skipped entirely", async () => {
    const app = buildApp(canvas({ passwordHash: null }), await mkAudit());
    const res = await app.request("/c/s/index.html");
    expect(await res.text()).toBe("CANVAS CONTENT");
  });

  it("GET without a valid cookie → 401 gate page", async () => {
    const cv = canvas({ passwordHash: await hashPassword("right") });
    const res = await buildApp(cv, await mkAudit()).request("/c/s/index.html");
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("password-protected");
  });

  it("gate page wears the shared branded system-page chrome (logo + tokens)", () => {
    const html = gatePage("My Canvas", false);
    // Same brand header and design tokens as the 4xx/5xx error pages — the gate
    // must not regress to a one-off look (§14.5).
    expect(html).toContain("canvas-drop");
    expect(html).toContain('viewBox="0 0 48 48"'); // the logo mark
    expect(html).toContain("--accent: #2563eb"); // canonical brand accent, not the old indigo
    expect(html).toContain("My Canvas is password-protected");
    expect(html).not.toContain("#6366f1"); // the old ad-hoc indigo is gone
  });

  it("escapes HTML in the canvas title on the gate page (no injection)", () => {
    const html = gatePage("<script>alert(1)</script> Canvas", false);
    // The title is interpolated through escapeHtml — the raw tag must never reach
    // the rendered page, only its escaped form.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("a grant for canvas A does not satisfy canvas B's gate", async () => {
    const grantForA = signGrant(config.sessionSecret, "cvA", 1);
    const cvB = canvas({ id: "cvB", passwordHash: await hashPassword("x") });
    const res = await buildApp(cvB, await mkAudit()).request("/c/s/index.html", {
      headers: { Cookie: `${GATE_COOKIE}=${grantForA}` },
    });
    expect(res.status).toBe(401); // wrong canvas id in the HMAC → invalid
  });

  it("rotating the password (passwordVersion bump) invalidates an outstanding grant", () => {
    const secret = config.sessionSecret;
    const cv = canvas({ passwordVersion: 1, passwordHash: "h" });
    const grantV1 = signGrant(secret, cv.id, 1);
    expect(verifyGrant(secret, cv, grantV1)).toBe(true);
    const rotated = { ...cv, passwordVersion: 2 };
    expect(verifyGrant(secret, rotated, grantV1)).toBe(false); // old grant rejected
  });

  it("gate cookie is HttpOnly and SameSite=Lax", async () => {
    const cv = canvas({ passwordHash: await hashPassword("right") });
    const res = await buildApp(cv, await mkAudit()).request("/c/s/index.html", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=right",
    });
    const raw = res.headers.getSetCookie().find((c) => c.startsWith(GATE_COOKIE));
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
  });

  it("throttles gate attempts past the per-user/canvas limit → 429 (§12.3)", async () => {
    const cv = canvas({ passwordHash: await hashPassword("right") });
    const lowConfig = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_RATELIMIT_PASSWORD_GATE_PER_MIN: "2",
    });
    const store = inProcessRateLimitStore();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "viewer" } as never);
      c.set("clientIp", "127.0.0.1");
      c.set("canvas", cv);
      c.set("needsPasswordGate", true);
      await next();
    });
    app.use(
      "*",
      passwordGate({ config: lowConfig, audit: await mkAudit(), rateLimitStore: store }),
    );
    app.all("*", (c) => c.text("CONTENT"));
    const attempt = () =>
      app.request("/c/s/index.html", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "password=wrong",
      });
    expect((await attempt()).status).toBe(401); // wrong password
    expect((await attempt()).status).toBe(401);
    const limited = await attempt(); // 3rd attempt exceeds the 2/min gate limit
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});

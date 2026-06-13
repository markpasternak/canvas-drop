import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { completeLogin, makeOidc, type OidcDeps } from "./oidc.js";
import { SESSION_COOKIE, sessionService } from "./session.js";

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const config: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvases.example.com",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_OIDC_ISSUER: "https://idp.example.com",
  CANVAS_DROP_OIDC_CLIENT_ID: "client",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
});

const OIDC_TX_COOKIE = "__canvasdrop_oidc";

function deps(client: DbClient): OidcDeps {
  return {
    config,
    users: usersRepository(client),
    sessionSvc: sessionService(config, sessionsRepository(client)),
    // Discovery must NOT run in these tests — they exercise pre-/post-exchange logic.
    getConfig: () => Promise.reject(new Error("discovery should not run")),
  };
}

function buildApp(client: DbClient) {
  const d = deps(client);
  const oidc = makeOidc(d);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("clientIp", "127.0.0.1");
    await next();
  });
  app.get("/auth/callback", (c) => oidc.callback(c));
  app.get("/complete", (c) =>
    completeLogin(d, c, { sub: "s", email: c.req.query("email") ?? "a@example.com" }),
  );
  return app;
}

describe("oidc callback — pre-exchange guards", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("rejects a callback with no transaction cookie", async () => {
    client = await makeTestDb("sqlite");
    const res = await buildApp(client).request("/auth/callback?state=abc&code=x");
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("missing_oidc_state");
  });

  it("rejects a callback whose state does not match the transaction (CSRF defense)", async () => {
    client = await makeTestDb("sqlite");
    const tx = encodeURIComponent(JSON.stringify({ state: "s1", verifier: "v1" }));
    const res = await buildApp(client).request("/auth/callback?state=s2&code=x", {
      headers: { Cookie: `${OIDC_TX_COOKIE}=${tx}` },
    });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("state_mismatch");
  });
});

describe("oidc completeLogin — security seam", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("creates the user, mints a session, and redirects on an allowed domain", async () => {
    client = await makeTestDb("sqlite");
    const res = await buildApp(client).request("/complete?email=ada@example.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.getSetCookie().some((c) => c.startsWith(SESSION_COOKIE))).toBe(true);
    expect(await usersRepository(client).findByProviderSub("s")).not.toBeNull();
  });

  it("rejects a login whose email domain is not allowed", async () => {
    client = await makeTestDb("sqlite");
    const res = await buildApp(client).request("/complete?email=attacker@evil.org");
    expect(res.status).toBe(403);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("email_domain_not_allowed");
  });
});

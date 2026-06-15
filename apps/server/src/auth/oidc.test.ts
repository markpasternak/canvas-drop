import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import * as client from "openid-client";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { allowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { callbackUrl, completeLogin, makeOidc, type OidcDeps } from "./oidc.js";
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
    allowedEmails: allowedEmailsRepository(client),
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

describe("oidc login — authorization request", () => {
  // A real openid-client Configuration built from static metadata — login()
  // does no network of its own, so buildAuthorizationUrl runs offline here.
  function loginApp(): Hono<AppEnv> {
    const cfg = new client.Configuration(
      {
        issuer: "https://idp.example.com",
        authorization_endpoint: "https://idp.example.com/authorize",
        token_endpoint: "https://idp.example.com/token",
        code_challenge_methods_supported: ["S256"],
      },
      "client",
      "secret",
    );
    const oidc = makeOidc({
      config,
      // biome-ignore lint/suspicious/noExplicitAny: repos unused by login()
      users: {} as any,
      allowedEmails: { isAllowed: async () => false },
      // biome-ignore lint/suspicious/noExplicitAny: session svc unused by login()
      sessionSvc: {} as any,
      getConfig: () => Promise.resolve(cfg),
    });
    const app = new Hono<AppEnv>();
    app.get("/auth/login", (c) => oidc.login(c));
    return app;
  }

  it("forces re-prompt with prompt=login so logout is not silently undone by IdP SSO", async () => {
    const res = await loginApp().request("/auth/login");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") as string);
    expect(loc.searchParams.get("prompt")).toBe("login");
    // sanity: the rest of the PKCE/state request is still well-formed
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    expect(loc.searchParams.get("state")).toBeTruthy();
  });
});

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

describe("oidc callbackUrl — proxy redirect_uri reconstruction", () => {
  it("builds the token-exchange redirect_uri from the base URL, not the proxied request scheme/host", () => {
    // Behind Caddy the app sees plain http on an internal host; the exchange
    // redirect_uri must still be the public https origin Google was given.
    const u = callbackUrl(
      "https://canvases.example.com",
      "http://localhost:3000/auth/callback?code=abc&state=s1&iss=https%3A%2F%2Fidp",
    );
    expect(`${u.origin}${u.pathname}`).toBe("https://canvases.example.com/auth/callback");
    expect(u.searchParams.get("code")).toBe("abc");
    expect(u.searchParams.get("state")).toBe("s1");
    expect(u.searchParams.get("iss")).toBe("https://idp");
  });

  it("accepts a URL object and preserves only the query (no path/host leakage)", () => {
    const u = callbackUrl(
      "https://canvases.example.com",
      new URL("https://evil.example.net/auth/callback/../../wat?code=x&state=y"),
    );
    expect(`${u.origin}${u.pathname}`).toBe("https://canvases.example.com/auth/callback");
    expect(u.searchParams.get("code")).toBe("x");
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

  it("admits an out-of-domain email that is on the individual allowlist (D14)", async () => {
    client = await makeTestDb("sqlite");
    // Rejection path first: out-of-domain is denied until allowlisted.
    expect((await buildApp(client).request("/complete?email=partner@external.com")).status).toBe(
      403,
    );
    await allowedEmailsRepository(client).add("partner@external.com", null);
    const res = await buildApp(client).request("/complete?email=partner@external.com");
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(SESSION_COOKIE))).toBe(true);
  });
});

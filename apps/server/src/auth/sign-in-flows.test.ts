import { createHash, randomBytes } from "node:crypto";
import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as client from "openid-client";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { allowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { memStorage } from "../storage/mem.js";
import { setupAuth } from "./factory.js";
import { makeOidc } from "./oidc.js";

/**
 * Sign-in flows end to end: a cookie-keeping "browser" follows real redirects through
 * the app and a fake OpenID provider, exactly as a person clicking a shared canvas link
 * would. Covers the signed-out and wrong-account journeys into a canvas, in both URL
 * modes, including the races (two tabs, background requests, the Back button) that
 * used to strand people on an error page or the wrong URL.
 */

const silent = pino({ level: "silent" });
const IDP = "https://idp.test";
const CLIENT_ID = "canvas-drop";

// ── Fake OpenID provider ─────────────────────────────────────────────────────

interface PendingCode {
  email: string;
  challenge: string;
  redirectUri: string;
}

async function fakeIdp() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, PendingCode>();
  /** Every authorization request the app sent us, in order. */
  const requests: URL[] = [];
  const idp = new Hono();

  idp.get("/.well-known/openid-configuration", (c) =>
    c.json({
      issuer: IDP,
      authorization_endpoint: `${IDP}/authorize`,
      token_endpoint: `${IDP}/token`,
      jwks_uri: `${IDP}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    }),
  );
  idp.get("/jwks", (c) => c.json({ keys: [jwk] }));
  idp.post("/token", async (c) => {
    const form = await c.req.parseBody();
    const pending = codes.get(String(form.code));
    codes.delete(String(form.code));
    const verifier = String(form.code_verifier ?? "");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!pending || pending.challenge !== challenge || pending.redirectUri !== form.redirect_uri) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      email: pending.email,
      email_verified: true,
      name: pending.email.split("@")[0],
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(IDP)
      .setAudience(CLIENT_ID)
      .setSubject(pending.email)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    return c.json({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken });
  });

  return {
    requests,
    /** The person signs in at the IdP as `email`: returns the callback URL it redirects to. */
    signIn(authorizeUrl: string, email: string): string {
      const url = new URL(authorizeUrl);
      requests.push(url);
      const code = randomBytes(16).toString("base64url");
      const redirectUri = url.searchParams.get("redirect_uri") as string;
      codes.set(code, {
        email,
        challenge: url.searchParams.get("code_challenge") as string,
        redirectUri,
      });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") as string);
      return back.href;
    },
    async getConfig(config: Config) {
      const fetchIdp: client.CustomFetch = (url, options) =>
        Promise.resolve(
          idp.request(url, {
            method: options.method,
            headers: options.headers,
            body: options.body as RequestInit["body"],
          }),
        );
      const cfg = await client.discovery(
        new URL(IDP),
        CLIENT_ID,
        config.auth.oidc.clientSecret as string,
        undefined,
        { [client.customFetch]: fetchIdp },
      );
      cfg[client.customFetch] = fetchIdp;
      return cfg;
    },
  };
}

// ── A browser: cookie jar + redirect following ───────────────────────────────

interface StoredCookie {
  name: string;
  value: string;
  /** Host for a host-only cookie, else the Domain attribute (no leading dot). */
  domain: string;
  hostOnly: boolean;
}

interface Visit {
  /** The final response (after following same-instance redirects). */
  res: Response;
  /** The final URL. */
  url: string;
  body: string;
  /** Set when the chain left for the identity provider: the authorize URL. */
  idp?: string;
}

class Browser {
  cookies: StoredCookie[] = [];
  constructor(private readonly app: Hono<never>) {}

  private store(host: string, res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const [pair, ...attrs] = header.split(";").map((p) => p.trim());
      const eq = (pair ?? "").indexOf("=");
      const name = (pair ?? "").slice(0, eq);
      const value = decodeURIComponent((pair ?? "").slice(eq + 1));
      const domainAttr = attrs.find((a) => /^domain=/i.test(a));
      const domain = domainAttr ? domainAttr.slice(7).replace(/^\./, "").toLowerCase() : host;
      const hostOnly = !domainAttr;
      this.cookies = this.cookies.filter(
        (ck) => !(ck.name === name && ck.domain === domain && ck.hostOnly === hostOnly),
      );
      const expired = attrs.some((a) => /^max-age=0$/i.test(a)) || value === "";
      if (!expired) this.cookies.push({ name, value, domain, hostOnly });
    }
  }

  cookieHeader(host: string): string {
    return this.cookies
      .filter((ck) =>
        ck.hostOnly ? ck.domain === host : host === ck.domain || host.endsWith(`.${ck.domain}`),
      )
      .map((ck) => `${ck.name}=${encodeURIComponent(ck.value)}`)
      .join("; ");
  }

  names(): string[] {
    return this.cookies.map((c) => c.name);
  }

  /** One request to the instance (no redirect following). */
  async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: RequestInit["body"] } = {},
  ): Promise<Response> {
    const u = new URL(url);
    const res = await this.app.request(`${u.pathname}${u.search}`, {
      method: init.method ?? "GET",
      body: init.body,
      headers: { host: u.host, cookie: this.cookieHeader(u.host), ...init.headers },
    });
    this.store(u.hostname, res);
    return res;
  }

  /**
   * A top-level navigation, following redirects (and the signed-out preview page's
   * meta refresh) until a page renders or the chain reaches the identity provider.
   */
  async navigate(
    url: string,
    opts: { site?: string; method?: string; body?: RequestInit["body"]; contentType?: string } = {},
  ): Promise<Visit> {
    let current = url;
    let site = opts.site ?? "none";
    let method = opts.method ?? "GET";
    let body = opts.body;
    for (let hop = 0; hop < 15; hop++) {
      if (new URL(current).origin === IDP)
        return { res: new Response(null), url: current, body: "", idp: current };
      const res = await this.request(current, {
        method,
        body,
        headers: {
          accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          "sec-fetch-site": site,
          ...(opts.contentType && body ? { "content-type": opts.contentType } : {}),
        },
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).href;
        site = "same-origin";
        method = "GET";
        body = undefined;
        continue;
      }
      const text = await res.text();
      const refresh = /http-equiv="refresh" content="0; url=([^"]+)"/.exec(text);
      if (refresh?.[1]) {
        current = new URL(refresh[1].replaceAll("&amp;", "&"), current).href;
        site = "same-origin";
        continue;
      }
      return { res, url: current, body: text };
    }
    throw new Error(`redirect loop from ${url}`);
  }

  /** A background fetch an open page makes (the SDK, the dashboard). */
  async fetch(url: string): Promise<Response> {
    return this.request(url, {
      headers: { accept: "application/json", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
    });
  }
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => (m[1] ?? "").replaceAll("&amp;", "&"));
}

function linkLabelled(html: string, label: string): string {
  const m = new RegExp(`<a[^>]*href="([^"]+)"[^>]*>${label}`).exec(html);
  if (!m?.[1]) throw new Error(`no "${label}" link in page`);
  return m[1].replaceAll("&amp;", "&");
}

// ── Instance under test ──────────────────────────────────────────────────────

async function* folder(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    yield { path, bytes: new TextEncoder().encode(content) };
  }
}

function oidcConfig(urlMode: "subdomain" | "path"): Config {
  return loadConfig({
    CANVAS_DROP_AUTH_MODE: "oidc",
    CANVAS_DROP_URL_MODE: urlMode,
    CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE: "true",
    CANVAS_DROP_BASE_URL: "https://canvases.test",
    CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
    CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
    CANVAS_DROP_OIDC_ISSUER: IDP,
    CANVAS_DROP_OIDC_CLIENT_ID: CLIENT_ID,
    CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
  });
}

async function instance(db: DbClient, urlMode: "subdomain" | "path" = "subdomain") {
  const config = oidcConfig(urlMode);
  const idp = await fakeIdp();
  const users = usersRepository(db);
  const allowedEmails = allowedEmailsRepository(db);
  const audit = createAuditLog(auditRepository(db), silent);
  const { strategy, sessionSvc } = setupAuth(config, {
    users,
    sessions: sessionsRepository(db),
    audit,
    allowedEmails,
  });
  const oidc = makeOidc({
    config,
    users,
    allowedEmails,
    sessionSvc: sessionSvc as NonNullable<typeof sessionSvc>,
    getConfig: () => idp.getConfig(config),
    audit,
  });
  const canvases = canvasesRepository(db);
  const versions = versionsRepository(db);
  const drafts = draftsRepository(db);
  const storage = memStorage();
  const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
  const app = buildApp({
    config,
    db,
    rootLogger: silent,
    strategy,
    sessionSvc,
    oidc,
    users,
    allowedEmails,
    canvases,
    versions,
    drafts,
    storage,
    engine,
    audit,
    peerIp: () => "203.0.113.7",
  });

  // owner@example.com owns two private canvases; other@example.com can open neither.
  const owner = await users.upsert({
    providerSub: "oidc:owner@example.com",
    email: "owner@example.com",
    name: "owner",
    isAdmin: false,
  });
  for (const slug of ["alpha", "beta"]) {
    const cv = await canvases.create({ ownerId: owner.id, slug, apiKeyHash: `h-${slug}` });
    await engine.deploy(cv, "api", folder({ "index.html": `<h1>${slug} content</h1>` }), owner.id);
    await canvases.setAccess(cv.id, "private");
  }
  const canvasUrl = (slug: string) =>
    urlMode === "subdomain" ? `https://${slug}.canvases.test/` : `https://canvases.test/c/${slug}/`;
  return { app: app as unknown as Hono<never>, idp, canvasUrl, config };
}

/** Sign in from scratch as `email` (via the dashboard) and return the browser. */
async function signedInAs(
  inst: Awaited<ReturnType<typeof instance>>,
  email: string,
): Promise<Browser> {
  const browser = new Browser(inst.app);
  const start = await browser.navigate("https://canvases.test/auth/login");
  await browser.navigate(inst.idp.signIn(start.idp as string, email), { site: "cross-site" });
  return browser;
}

describe.each(DIALECTS)("sign-in flows into a canvas [%s]", (dialect) => {
  let db: DbClient;
  afterEach(async () => {
    await db?.close();
  });

  for (const urlMode of ["subdomain", "path"] as const) {
    it(`${urlMode}: a signed-out visitor signs in and lands on the canvas they opened`, async () => {
      db = await makeTestDb(dialect);
      const inst = await instance(db, urlMode);
      const browser = new Browser(inst.app);

      const opened = await browser.navigate(inst.canvasUrl("alpha"));
      expect(opened.idp).toBeDefined();
      expect(new URL(opened.idp as string).searchParams.get("prompt")).toBe("login");

      const landed = await browser.navigate(
        inst.idp.signIn(opened.idp as string, "owner@example.com"),
        { site: "cross-site" },
      );
      expect(landed.url).toBe(inst.canvasUrl("alpha"));
      expect(landed.res.status).toBe(200);
      expect(landed.body).toContain("alpha content");
    });
  }

  it("a deep link's #route survives sign-in", async () => {
    db = await makeTestDb(dialect);
    const inst = await instance(db);
    const browser = new Browser(inst.app);
    // What the signed-out preview page's script requests for `alpha/#/board/42`
    // (social-preview.test.ts runs that script).
    const deepLink = `${inst.canvasUrl("alpha")}#/board/42`;
    const opened = await browser.navigate(
      `${inst.canvasUrl("alpha")}auth/login?returnTo=${encodeURIComponent(deepLink)}`,
    );
    const landed = await browser.navigate(
      inst.idp.signIn(opened.idp as string, "owner@example.com"),
      { site: "cross-site" },
    );
    expect(landed.url).toBe(deepLink);
    expect(landed.body).toContain("alpha content");
  });

  it("two tabs signing in at once each land on their own canvas", async () => {
    db = await makeTestDb(dialect);
    const inst = await instance(db);
    const browser = new Browser(inst.app);

    // Both shared links are opened while signed out (two tabs, or a restored session).
    const tabA = await browser.navigate(inst.canvasUrl("alpha"));
    const tabB = await browser.navigate(inst.canvasUrl("beta"));
    expect(tabA.idp).toBeDefined();
    expect(tabB.idp).toBeDefined();

    const landedA = await browser.navigate(
      inst.idp.signIn(tabA.idp as string, "owner@example.com"),
      { site: "cross-site" },
    );
    expect(landedA.url).toBe(inst.canvasUrl("alpha"));
    expect(landedA.body).toContain("alpha content");

    const landedB = await browser.navigate(
      inst.idp.signIn(tabB.idp as string, "owner@example.com"),
      { site: "cross-site" },
    );
    expect(landedB.url).toBe(inst.canvasUrl("beta"));
    expect(landedB.body).toContain("beta content");
    // Every per-sign-in transaction cookie was consumed.
    expect(browser.names().filter((n) => n.startsWith("__canvasdrop_oidc"))).toEqual([]);
  });

  it("background requests from an open page don't hijack a sign-in in progress", async () => {
    db = await makeTestDb(dialect);
    const inst = await instance(db);
    const browser = new Browser(inst.app);

    const opened = await browser.navigate(inst.canvasUrl("alpha"));
    // An expired canvas tab keeps polling the runtime API and loading assets.
    for (let i = 0; i < 12; i++) {
      const api = await browser.fetch("https://canvases.test/v1/c/beta/kv/notes");
      expect(api.status).toBe(401);
      expect(api.headers.getSetCookie()).toEqual([]);
      const asset = await browser.request(`${inst.canvasUrl("beta")}logo.png`, {
        headers: { accept: "image/*", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
      });
      expect(asset.status).toBe(401);
    }

    // ...and the person's own sign-in still completes (and isn't rate limited).
    const landed = await browser.navigate(
      inst.idp.signIn(opened.idp as string, "owner@example.com"),
      { site: "cross-site" },
    );
    expect(landed.url).toBe(inst.canvasUrl("alpha"));
    expect(landed.body).toContain("alpha content");
  });

  it("going Back onto a used sign-in callback while signed in opens the dashboard, not an error", async () => {
    db = await makeTestDb(dialect);
    const inst = await instance(db);
    const browser = new Browser(inst.app);
    const opened = await browser.navigate(inst.canvasUrl("alpha"));
    const callback = inst.idp.signIn(opened.idp as string, "owner@example.com");
    await browser.navigate(callback, { site: "cross-site" });

    const replay = await browser.request(callback, {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe("/");
  });

  it("a stale session cookie still signs in and lands on the canvas", async () => {
    db = await makeTestDb(dialect);
    const inst = await instance(db);
    const browser = new Browser(inst.app);
    browser.cookies.push({
      name: "__canvasdrop_session",
      value: randomBytes(32).toString("base64url"),
      domain: "canvases.test",
      hostOnly: false,
    });
    const opened = await browser.navigate(inst.canvasUrl("alpha"));
    const landed = await browser.navigate(
      inst.idp.signIn(opened.idp as string, "owner@example.com"),
      { site: "cross-site" },
    );
    expect(landed.url).toBe(inst.canvasUrl("alpha"));
    expect(landed.body).toContain("alpha content");
  });

  it("signing in with an account that isn't allowed offers a retry that still returns to the canvas", async () => {
    db = await makeTestDb(dialect);
    const inst = await instance(db);
    const browser = new Browser(inst.app);
    const opened = await browser.navigate(inst.canvasUrl("alpha"));
    const refused = await browser.navigate(
      inst.idp.signIn(opened.idp as string, "someone@gmail.com"),
      { site: "cross-site" },
    );
    expect(refused.res.status).toBe(400);
    expect(refused.body).toContain("allowed to sign in to this instance");

    const retry = await browser.navigate(
      new URL(linkLabelled(refused.body, "Try signing in again"), "https://canvases.test/").href,
      { site: "same-origin" },
    );
    const landed = await browser.navigate(
      inst.idp.signIn(retry.idp as string, "owner@example.com"),
      { site: "cross-site" },
    );
    expect(landed.url).toBe(inst.canvasUrl("alpha"));
    expect(landed.body).toContain("alpha content");
  });

  for (const urlMode of ["subdomain", "path"] as const) {
    it(`${urlMode}: signed in with the wrong account, "Use another account" adds the right one and returns to the canvas`, async () => {
      db = await makeTestDb(dialect);
      const inst = await instance(db, urlMode);
      const browser = await signedInAs(inst, "other@example.com");

      const denied = await browser.navigate(inst.canvasUrl("alpha"));
      expect(denied.res.status).toBe(404);
      expect(denied.body).toContain("Signed in as <strong>other@example.com</strong>");
      expect(denied.body).not.toContain("Continue as");

      // Use another account → the chooser has nobody else → straight to the IdP picker.
      const chooser = linkLabelled(denied.body, "Use another account");
      const picker = await browser.navigate(chooser, { site: "same-site" });
      expect(new URL(picker.idp as string).searchParams.get("prompt")).toBe("select_account");

      const landed = await browser.navigate(
        inst.idp.signIn(picker.idp as string, "owner@example.com"),
        { site: "cross-site" },
      );
      expect(landed.url).toBe(inst.canvasUrl("alpha"));
      expect(landed.body).toContain("alpha content");

      // Both accounts stay signed in: other is one click away in the switcher.
      const others = await browser.fetch("https://canvases.test/api/me/accounts");
      const { accounts } = (await others.json()) as { accounts: Array<{ email: string }> };
      expect(accounts.map((a) => a.email)).toEqual(["other@example.com"]);
    });
  }

  it('with the right account already signed in, "Continue as" switches and returns to the canvas', async () => {
    db = await makeTestDb(dialect);
    const inst = await instance(db);
    // Signed in as owner, then added other (now active).
    const browser = await signedInAs(inst, "owner@example.com");
    const add = await browser.navigate("https://canvases.test/auth/login?add=1");
    await browser.navigate(inst.idp.signIn(add.idp as string, "other@example.com"), {
      site: "cross-site",
    });

    const denied = await browser.navigate(inst.canvasUrl("alpha"));
    expect(denied.res.status).toBe(404);
    const chooserUrl = linkLabelled(denied.body, "Continue as owner@example.com");

    const chooser = await browser.navigate(chooserUrl, { site: "same-site" });
    expect(chooser.res.status).toBe(200);
    expect(chooser.body).toContain("Continue as owner@example.com?");
    const account = /name="account" value="([^"]+)"/.exec(chooser.body)?.[1] as string;
    const returnTo = /name="returnTo" value="([^"]+)"/.exec(chooser.body)?.[1] as string;

    const landed = await browser.navigate("https://canvases.test/auth/switch", {
      method: "POST",
      site: "same-origin",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({ account, returnTo: returnTo.replaceAll("&amp;", "&") }),
    });
    expect(landed.url).toBe(inst.canvasUrl("alpha"));
    expect(landed.body).toContain("alpha content");
  });

  it("the signed-out preview page and every sign-in link point back at the canvas", async () => {
    db = await makeTestDb(dialect);
    const inst = await instance(db);
    const browser = new Browser(inst.app);
    const res = await browser.request(inst.canvasUrl("alpha"), {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });
    const html = await res.text();
    const logins = hrefs(html).filter((h) => h.startsWith("/auth/login"));
    expect(logins.length).toBeGreaterThan(0);
    for (const href of logins) {
      expect(new URL(href, "https://canvases.test").searchParams.get("returnTo")).toBe(
        inst.canvasUrl("alpha"),
      );
    }
  });
});

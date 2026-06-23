import { type Config, loadConfig } from "@canvas-drop/shared";
import type { User } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorPageMiddleware, errorResponse, wantsHtmlError } from "./error-pages.js";
import { securityHeadersMiddleware } from "./security-headers.js";
import type { AppEnv } from "./types.js";

const HTML = { Accept: "text/html", Host: "art.canvases.example.com" } as const;

function subdomainConfig(mode: "oidc" | "dev" | "proxy"): Config {
  return loadConfig({
    CANVAS_DROP_AUTH_MODE: mode,
    CANVAS_DROP_URL_MODE: "subdomain",
    CANVAS_DROP_BASE_URL: "https://canvases.example.com",
    CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
    CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
    ...(mode === "oidc"
      ? {
          CANVAS_DROP_OIDC_ISSUER: "https://idp.example.com",
          CANVAS_DROP_OIDC_CLIENT_ID: "client",
          CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
        }
      : {}),
    ...(mode === "proxy" ? { CANVAS_DROP_TRUSTED_PROXY_IPS: "127.0.0.1" } : {}),
  });
}

/** App that mirrors prod wiring: config on the context, an optional signed-in user,
 *  then the error-page middleware — so a canvas-subdomain request renders the branded
 *  page with config-derived recovery affordances. */
function recoveryApp(config: Config, user?: Pick<User, "email">) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("config", config);
    if (user) c.set("user", user as User);
    await next();
  });
  app.use("*", securityHeadersMiddleware());
  app.use("*", errorPageMiddleware());
  // A non-existent canvas and an existing-but-forbidden canvas both surface this exact
  // JSON 404 (canvasAccess collapses them, §12.0 no-leak) → rewritten to HTML here.
  app.get("/denied", (c) => c.json({ error: "not_found" }, 404));
  app.get("/missing", (c) => c.json({ error: "not_found" }, 404));
  app.get("/disabled", (c) =>
    errorResponse(
      c,
      { status: 403, code: "disabled", title: "This canvas is disabled", hideIdentity: true },
      { error: "disabled" },
    ),
  );
  return app;
}

/** Request a path and return the rendered HTML body (awaits Hono's sync-or-async request). */
async function htmlOf(app: Hono<AppEnv>, path: string): Promise<string> {
  const res = await app.request(path, { headers: HTML });
  return res.text();
}

function appFor() {
  const app = new Hono<AppEnv>();
  app.use("*", securityHeadersMiddleware());
  app.use("*", errorPageMiddleware());
  app.get("/missing", (c) => c.json({ error: "not_found", message: "No <page> & no stack" }, 404));
  app.get("/limited", (c) => {
    c.header("Retry-After", "12");
    c.header("X-RateLimit-Limit", "1");
    return c.json({ error: "rate_limited" }, 429);
  });
  app.get("/boom", () => {
    throw new Error("secret stack details");
  });
  app.notFound((c) =>
    errorResponse(
      c,
      {
        status: 404,
        code: "not_found",
        title: "Page not found",
        message: "There is no page at this address.",
      },
      { error: "not_found" },
    ),
  );
  app.onError((_, c) =>
    errorResponse(
      c,
      {
        status: 500,
        code: "internal_server_error",
        title: "Internal server error",
        message: "The server hit an unexpected problem. Please try again.",
      },
      { error: "internal_server_error" },
    ),
  );
  return app;
}

describe("wantsHtmlError", () => {
  it("only treats explicit text/html preference as a browser error-page request", () => {
    expect(wantsHtmlError(null)).toBe(false);
    expect(wantsHtmlError("*/*")).toBe(false);
    expect(wantsHtmlError("application/json")).toBe(false);
    expect(wantsHtmlError("application/json, text/html")).toBe(false);
    expect(wantsHtmlError("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(
      true,
    );
  });
});

describe("errorPageMiddleware", () => {
  it("converts JSON errors to escaped HTML for browser navigations", async () => {
    const res = await appFor().request("/missing", { headers: { Accept: "text/html" } });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("vary")).toContain("Accept");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toContain("canvas-drop");
    expect(html).toContain('viewBox="158 209 372 432"');
    expect(html).toContain("M245 335H218");
    expect(html).toContain("Page not found");
    expect(html).toContain("No &lt;page&gt; &amp; no stack");
    expect(html).toContain("/missing");
  });

  it("leaves JSON untouched for API clients and ambiguous accepts", async () => {
    const json = await appFor().request("/missing", {
      headers: { Accept: "application/json" },
    });
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.json()).toEqual({
      error: "not_found",
      message: "No <page> & no stack",
    });

    const ambiguous = await appFor().request("/missing", { headers: { Accept: "*/*" } });
    expect(ambiguous.headers.get("content-type")).toContain("application/json");
    expect(await ambiguous.json()).toMatchObject({ error: "not_found" });
  });

  it("preserves rate-limit headers when rendering HTML", async () => {
    const res = await appFor().request("/limited", { headers: { Accept: "text/html" } });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(res.headers.get("x-ratelimit-limit")).toBe("1");
    expect(await res.text()).toContain("Too many requests");
  });

  it("renders generic 500 pages without leaking thrown error details", async () => {
    const res = await appFor().request("/boom", { headers: { Accept: "text/html" } });

    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain("Internal server error");
    expect(html).not.toContain("secret stack details");
  });

  it("uses the shared page for Hono notFound fallbacks", async () => {
    const res = await appFor().request("/no-route", { headers: { Accept: "text/html" } });

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("There is no page at this address.");
  });
});

describe("error-page recovery actions", () => {
  it("links the dashboard ABSOLUTELY (not relative `/`) so it escapes a canvas subdomain", async () => {
    const html = await htmlOf(
      recoveryApp(subdomainConfig("oidc"), { email: "a@example.com" }),
      "/missing",
    );
    // The primary action points at the apex dashboard, never the canvas subdomain root.
    expect(html).toContain('href="https://canvases.example.com/"');
    expect(html).toContain("Open dashboard");
    // A bare `<a href="/">` (the old bug) would loop back to the canvas — must be gone.
    expect(html).not.toContain('<a href="/">');
  });

  it("shows a signed-in member's identity + a real absolute logout (oidc)", async () => {
    const html = await htmlOf(
      recoveryApp(subdomainConfig("oidc"), { email: "mark@example.com" }),
      "/missing",
    );
    expect(html).toContain("Signed in as");
    expect(html).toContain("mark@example.com");
    expect(html).toContain('href="https://canvases.example.com/auth/logout"');
  });

  it("shows logout in dev mode too (app owns the session)", async () => {
    const html = await htmlOf(
      recoveryApp(subdomainConfig("dev"), { email: "dev@example.com" }),
      "/missing",
    );
    expect(html).toContain("dev@example.com");
    expect(html).toContain("/auth/logout");
  });

  it("offers no sign-out in proxy mode (the IAP owns the session)", async () => {
    const html = await htmlOf(
      recoveryApp(subdomainConfig("proxy"), { email: "p@example.com" }),
      "/missing",
    );
    expect(html).not.toContain("Signed in as");
    expect(html).not.toContain("/auth/logout");
    // The absolute dashboard link is still there — that's the universal fix.
    expect(html).toContain('href="https://canvases.example.com/"');
  });

  it("offers an absolute sign-in carrying returnTo when signed out (oidc)", async () => {
    const html = await htmlOf(recoveryApp(subdomainConfig("oidc")), "/missing");
    expect(html).toContain("Sign in");
    expect(html).toContain("https://canvases.example.com/auth/login?returnTo=");
    // The intended canvas URL is carried so login returns the visitor there.
    expect(html).toContain(encodeURIComponent("https://art.canvases.example.com/missing"));
    expect(html).not.toContain("Signed in as");
  });

  it("keeps access-denied and genuine-404 pages identical apart from the path (no §12.0 leak)", async () => {
    // Both an existing-but-forbidden canvas and a non-existent one return the same JSON
    // 404; the rendered page must not key on the access decision. The only legitimate
    // difference is the echoed request path, so normalize it out and require the rest —
    // identity footer, actions, code, title, message — to be byte-identical.
    const app = recoveryApp(subdomainConfig("oidc"), { email: "a@example.com" });
    const [denied, missing] = await Promise.all([htmlOf(app, "/denied"), htmlOf(app, "/missing")]);
    expect(denied.replaceAll("/denied", "PATH")).toBe(missing.replaceAll("/missing", "PATH"));
  });

  it("suppresses the identity footer on the public disabled page (hideIdentity)", async () => {
    const html = await htmlOf(
      recoveryApp(subdomainConfig("oidc"), { email: "a@example.com" }),
      "/disabled",
    );
    expect(html).toContain("This canvas is disabled");
    // Neutral for every visitor: no "Signed in as …", but the dashboard link still works.
    expect(html).not.toContain("Signed in as");
    expect(html).toContain('href="https://canvases.example.com/"');
  });
});

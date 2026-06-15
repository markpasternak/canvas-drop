import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../auth/session.js";
import { socialPreview } from "./social-preview.js";
import type { AppEnv } from "./types.js";

const oidc: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvas-drop.com",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_OIDC_ISSUER: "https://accounts.google.com",
  CANVAS_DROP_OIDC_CLIENT_ID: "cid",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
});
const dev: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

/** Mount the middleware ahead of a sentinel that marks "the gateway would run". */
function app(config: Config) {
  const a = new Hono<AppEnv>();
  a.use("*", socialPreview(config));
  a.all("*", (c) => c.text("PASSED_THROUGH", 418));
  return a;
}

const HTML = { accept: "text/html,application/xhtml+xml" };

describe("socialPreview", () => {
  it("serves a generic OG card to a signed-out HTML navigation in oidc mode", async () => {
    const res = await app(oidc).request("/", {
      headers: { host: "showcase.canvas-drop.com", ...HTML },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // Absolute og:image on THIS host (subdomain), not the apex.
    expect(body).toContain('property="og:image" content="https://showcase.canvas-drop.com/og.png"');
    expect(body).toContain('name="twitter:card" content="summary_large_image"');
    // Humans are redirected on to login (parity with the gateway).
    expect(body).toContain("url=/auth/login");
    expect(body).toContain('location.replace("/auth/login")');
    // Never indexed.
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("catches a crawler that sends Accept: */* but a recognizable UA", async () => {
    const res = await app(oidc).request("/c/app/", {
      headers: { host: "canvas-drop.com", accept: "*/*", "user-agent": "facebookexternalhit/1.1" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("og:image");
  });

  it("passes through when a session cookie is present (let the gateway decide)", async () => {
    const res = await app(oidc).request("/", {
      headers: { host: "showcase.canvas-drop.com", ...HTML, cookie: `${SESSION_COOKIE}=tok` },
    });
    expect(res.status).toBe(418);
  });

  it("passes through non-document requests (API/asset fetches)", async () => {
    const res = await app(oidc).request("/api/me", {
      headers: { host: "canvas-drop.com", accept: "application/json" },
    });
    expect(res.status).toBe(418);
  });

  it("passes through non-GET requests", async () => {
    const res = await app(oidc).request("/", {
      method: "POST",
      headers: { host: "x.canvas-drop.com", ...HTML },
    });
    expect(res.status).toBe(418);
  });

  it("is a no-op outside oidc mode (dev/proxy don't bounce to an external login)", async () => {
    const res = await app(dev).request("/", { headers: { host: "localhost", ...HTML } });
    expect(res.status).toBe(418);
  });
});

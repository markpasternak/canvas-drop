import { type Config, loadConfig } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import { loginUrl, publicOrigin, requestReturnTo, safeReturnTo } from "./return-to.js";

const subdomain: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvases.example.com",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_OIDC_ISSUER: "https://idp.example.com",
  CANVAS_DROP_OIDC_CLIENT_ID: "client",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
});

describe("safeReturnTo — open-redirect defense", () => {
  it("accepts a same-site relative path", () => {
    expect(safeReturnTo(subdomain, "/c/abc/")).toBe("/c/abc/");
    expect(safeReturnTo(subdomain, "/gallery?tag=art")).toBe("/gallery?tag=art");
  });

  it("accepts an absolute URL on the apex or a canvas subdomain", () => {
    expect(safeReturnTo(subdomain, "https://canvases.example.com/gallery")).toBe(
      "https://canvases.example.com/gallery",
    );
    expect(safeReturnTo(subdomain, "https://my-canvas.canvases.example.com/")).toBe(
      "https://my-canvas.canvases.example.com/",
    );
  });

  it("rejects protocol-relative and backslash tricks", () => {
    expect(safeReturnTo(subdomain, "//evil.com")).toBeUndefined();
    expect(safeReturnTo(subdomain, "/\\evil.com")).toBeUndefined();
    expect(safeReturnTo(subdomain, "/%2fevil.com")).toBeUndefined();
    expect(safeReturnTo(subdomain, "/%2Fevil.com")).toBeUndefined();
  });

  it("rejects off-host absolute URLs and lookalike suffixes", () => {
    expect(safeReturnTo(subdomain, "https://evil.com/")).toBeUndefined();
    // Not a real subdomain — a sibling host that merely ends with the brand string.
    expect(safeReturnTo(subdomain, "https://evilcanvases.example.com/")).toBeUndefined();
    expect(safeReturnTo(subdomain, "https://canvases.example.com.evil.com/")).toBeUndefined();
  });

  it("rejects a scheme downgrade", () => {
    expect(safeReturnTo(subdomain, "http://canvases.example.com/")).toBeUndefined();
  });

  it("rejects auth-surface targets to avoid login loops", () => {
    expect(safeReturnTo(subdomain, "/auth/login")).toBeUndefined();
    expect(safeReturnTo(subdomain, "/auth/callback?code=x")).toBeUndefined();
    expect(safeReturnTo(subdomain, "https://canvases.example.com/auth/login")).toBeUndefined();
  });

  it("treats empty/garbage as no destination", () => {
    expect(safeReturnTo(subdomain, undefined)).toBeUndefined();
    expect(safeReturnTo(subdomain, "")).toBeUndefined();
    expect(safeReturnTo(subdomain, "not a url")).toBeUndefined();
  });
});

describe("loginUrl", () => {
  it("appends a validated, encoded returnTo", () => {
    expect(loginUrl(subdomain, "https://my-canvas.canvases.example.com/")).toBe(
      "/auth/login?returnTo=https%3A%2F%2Fmy-canvas.canvases.example.com%2F",
    );
  });

  it("drops an unsafe returnTo rather than forwarding it", () => {
    expect(loginUrl(subdomain, "https://evil.com")).toBe("/auth/login");
    expect(loginUrl(subdomain, undefined)).toBe("/auth/login");
  });
});

describe("publicOrigin / requestReturnTo — proxy hop", () => {
  it("rebuilds the public origin from the forwarded Host, not the internal request scheme", () => {
    // Behind Caddy the app sees http on localhost; the returnTo must carry the
    // public https canvas subdomain so the user lands back on the right host.
    expect(publicOrigin(subdomain, "my-canvas.canvases.example.com")).toBe(
      "https://my-canvas.canvases.example.com",
    );
    expect(
      requestReturnTo(
        subdomain,
        "my-canvas.canvases.example.com",
        "http://localhost:3000/dashboard?x=1",
      ),
    ).toBe("https://my-canvas.canvases.example.com/dashboard?x=1");
  });

  it("falls back to the configured host when no Host header is present", () => {
    expect(publicOrigin(subdomain, undefined)).toBe("https://canvases.example.com");
  });
});

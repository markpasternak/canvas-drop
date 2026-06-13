import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../http/types.js";
import { serveSpa } from "./serve-spa.js";

/** A Hono app that sets the dashboard role then runs serveSpa (mirrors app.ts). */
function appFor(config: Config, role = "dashboard") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("role", role as never);
    await next();
  });
  const dashboard = serveSpa({ config });
  app.use("*", (c, next) => (c.get("role") === "dashboard" ? dashboard(c, next) : next()));
  app.all("*", (c) => c.json({ error: "not_implemented" }, 404));
  return app;
}

describe("serveSpa", () => {
  let dist: string;
  let config: Config;

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "cd-spa-"));
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<!doctype html><div id=root></div>");
    await writeFile(join(dist, "assets", "app-abc123.js"), "console.log(1)");
    config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev", CANVAS_DROP_DASHBOARD_DIST: dist });
  });
  afterEach(() => {
    config = undefined as never;
  });

  it("serves index.html (no-cache) with the strict CSP + security headers", async () => {
    const res = await appFor(config).request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves a hashed asset with an immutable cache + correct MIME", async () => {
    const res = await appFor(config).request("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("history-falls back to index.html for an unknown SPA route", async () => {
    const res = await appFor(config).request("/c/some-id/settings");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("does not serve the SPA for a non-dashboard role", async () => {
    const res = await appFor(config, "platform-api").request("/c/x/kv/y");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_implemented" });
  });

  it("rejects path traversal (stays within dist) by falling back to index.html", async () => {
    const res = await appFor(config).request("/../../../../etc/passwd");
    // Never serves /etc/passwd — either the index fallback or a safe miss.
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("returns 503 when the SPA isn't built", async () => {
    const missing = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_DASHBOARD_DIST: join(dist, "does-not-exist"),
    });
    const res = await appFor(missing).request("/");
    expect(res.status).toBe(503);
  });
});

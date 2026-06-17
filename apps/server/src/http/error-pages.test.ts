import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorPageMiddleware, errorResponse, wantsHtmlError } from "./error-pages.js";
import { securityHeadersMiddleware } from "./security-headers.js";
import type { AppEnv } from "./types.js";

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

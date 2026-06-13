import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { baseSecurityHeaders, securityHeadersMiddleware } from "./security-headers.js";
import type { AppEnv } from "./types.js";

describe("security headers", () => {
  it("baseSecurityHeaders sets nosniff + Referrer-Policy + COOP", () => {
    const h = new Headers();
    baseSecurityHeaders(h);
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("same-origin");
    expect(h.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("the fallback middleware applies the baseline to a c.json response", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", securityHeadersMiddleware());
    app.get("/", (c) => c.json({ ok: true }));
    const res = await app.request("/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });
});

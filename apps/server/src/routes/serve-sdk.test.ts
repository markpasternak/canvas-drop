import { describe, expect, it } from "vitest";
import { serveSdkRoutes } from "./serve-sdk.js";

describe("serveSdkRoutes", () => {
  it("serves the bundle as JavaScript", async () => {
    const app = serveSdkRoutes({ loadBundle: () => "window.canvasdrop={};" });
    const res = await app.request("/sdk/v1.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(await res.text()).toBe("window.canvasdrop={};");
  });

  it("carries the baseline security headers (self-Response doesn't bypass them)", async () => {
    const app = serveSdkRoutes({ loadBundle: () => "window.canvasdrop={};" });
    const res = await app.request("/sdk/v1.js");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("503s with guidance when the bundle isn't built", async () => {
    const app = serveSdkRoutes({ loadBundle: () => null });
    const res = await app.request("/sdk/v1.js");
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/pnpm build/);
  });

  it("no longer serves /llms.txt here — it moved to the public docs band (U4)", async () => {
    const app = serveSdkRoutes({ loadBundle: () => "x" });
    const res = await app.request("/llms.txt");
    expect(res.status).toBe(404);
  });
});

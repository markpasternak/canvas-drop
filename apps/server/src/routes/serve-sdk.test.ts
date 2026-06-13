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

  it("503s with guidance when the bundle isn't built", async () => {
    const app = serveSdkRoutes({ loadBundle: () => null });
    const res = await app.request("/sdk/v1.js");
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/pnpm build/);
  });
});

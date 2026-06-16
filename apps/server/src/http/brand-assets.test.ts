import { describe, expect, it } from "vitest";
import { brandAssetRoutes } from "./brand-assets.js";

describe("brandAssetRoutes — public favicon / brand icons", () => {
  it("serves favicon.svg publicly with the svg content-type", async () => {
    const res = await brandAssetRoutes().request("/favicon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toContain("max-age");
  });

  it("serves the web manifest and the icons it references", async () => {
    const manifest = await brandAssetRoutes().request("/site.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain("manifest");
    const mark = await brandAssetRoutes().request("/brand/canvasdrop-mark-192.png");
    expect(mark.status).toBe(200);
    expect(mark.headers.get("content-type")).toBe("image/png");
  });

  it("404s a path outside the allowlist", async () => {
    const res = await brandAssetRoutes().request("/favicon.ico");
    expect(res.status).toBe(404);
  });
});

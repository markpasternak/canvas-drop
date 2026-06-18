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

  it("self-hosts the Newsreader woff2 (normal + italic) with the font content-type + long cache", async () => {
    for (const file of [
      "/fonts/newsreader-latin-wght-normal.woff2",
      "/fonts/newsreader-latin-standard-italic.woff2",
    ]) {
      const res = await brandAssetRoutes().request(file);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(res.headers.get("cache-control")).toContain("max-age=31536000");
      // A real woff2 begins with the `wOF2` signature.
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("wOF2");
    }
  });

  it("404s an unknown font file", async () => {
    const res = await brandAssetRoutes().request("/fonts/does-not-exist.woff2");
    expect(res.status).toBe(404);
  });
});

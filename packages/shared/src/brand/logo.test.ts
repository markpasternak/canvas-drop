import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { brandMarkSvg, LOGO_PATHS, LOGO_VIEWBOX } from "./logo.js";

describe("brand geometry parity", () => {
  it("keeps the dashboard mirror and public vector downloads aligned with the server mark", () => {
    const dashboard = readFileSync("apps/dashboard/src/components/Brand.tsx", "utf8");
    const download = readFileSync("apps/dashboard/public/brand/canvasdrop-mark.svg", "utf8");
    const wordmark = readFileSync("apps/dashboard/public/brand/canvasdrop-logo.svg", "utf8");
    for (const source of [dashboard, download, wordmark, brandMarkSvg()]) {
      expect(source).toContain(`viewBox="${LOGO_VIEWBOX}"`);
      for (const path of [LOGO_PATHS.frame, ...LOGO_PATHS.drop]) {
        const element = source.match(/<path\b[^>]*>/g)?.find((element) => element.includes(path.d));
        expect(element).toMatch(new RegExp(`stroke-?[Ww]idth="${path.width}"`));
      }
    }
  });

  it("gives installed app icons an opaque background", async () => {
    for (const file of [
      "apple-touch-icon.png",
      "brand/canvasdrop-mark-192.png",
      "brand/canvasdrop-mark-512.png",
    ]) {
      expect((await sharp(`apps/dashboard/public/${file}`).stats()).isOpaque).toBe(true);
    }
  });

  it("keeps the frame and drop at favicon sizes while omitting fine code detail", () => {
    const favicon = readFileSync("apps/dashboard/public/favicon.svg", "utf8");
    expect(favicon).toContain(LOGO_PATHS.frame.d);
    expect(favicon).toContain(LOGO_PATHS.drop[0].d);
    expect(favicon).not.toContain(LOGO_PATHS.drop[1].d);
    expect(favicon).toContain("prefers-color-scheme:dark");
    expect(brandMarkSvg({ compact: true, frame: "#111", drop: "#111" })).not.toContain("var(");
  });
});

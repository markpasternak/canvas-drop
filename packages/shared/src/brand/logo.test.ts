import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brandMarkSvg, LOGO_PATHS, LOGO_VIEWBOX } from "./logo.js";

describe("brand geometry parity", () => {
  it("keeps the dashboard mirror and public vector downloads aligned with the server mark", () => {
    const dashboard = readFileSync("apps/dashboard/src/components/Brand.tsx", "utf8");
    const download = readFileSync("apps/dashboard/public/brand/canvasdrop-mark.svg", "utf8");
    const wordmark = readFileSync("apps/dashboard/public/brand/canvasdrop-logo.svg", "utf8");
    for (const source of [dashboard, download, wordmark, brandMarkSvg()]) {
      expect(source).toContain(`viewBox="${LOGO_VIEWBOX}"`);
      for (const path of [LOGO_PATHS.frame, ...LOGO_PATHS.drop]) expect(source).toContain(path.d);
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

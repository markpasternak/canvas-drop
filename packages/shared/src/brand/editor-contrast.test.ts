import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { oklchToHex } from "./contrast.js";
import { SKIN_NAMES, SKINS, SYNTAX_TOKENS } from "./skins.js";
import { BRAND_TOKENS } from "./tokens.js";

const css = readFileSync(
  new URL("../../../../apps/dashboard/src/styles/tokens.css", import.meta.url),
  "utf8",
);
const comments = [...css.matchAll(/--syn-comment:\s*(oklch\([^;]+\))/g)].map(
  (match) => match[1] as string,
);
const rgb = (value: string) => {
  const hex = oklchToHex(value);
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
};
const blend = (over: number[], under: number[], alpha: number) =>
  over.map((value, i) => value * alpha + (under[i] ?? 0) * (1 - alpha));
const luminance = (values: number[]) =>
  values
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * ([0.2126, 0.7152, 0.0722][index] ?? 0), 0);
const ratio = (a: number[], b: number[]) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

describe("code comment contrast on real editor surfaces", () => {
  it("keeps CSS themes aligned with the canonical syntax palette", () => {
    expect(comments).toHaveLength(3);
    expect(comments[0]).toBe(SYNTAX_TOKENS.light["syn-comment"]);
    expect(comments[1]).toBe(SYNTAX_TOKENS.dark["syn-comment"]);
    expect(comments[1]).toBe(comments[2]);
  });
  for (const theme of ["light", "dark"] as const) {
    for (const skin of SKIN_NAMES) {
      it(`${theme}/${skin} clears 4.5:1 on plain, active and selected lines`, () => {
        const foreground = rgb(SYNTAX_TOKENS[theme]["syn-comment"]);
        const surface = rgb(BRAND_TOKENS[theme].surface);
        const active = blend(rgb(SKINS[skin][theme]["accent-subtle"]), surface, 0.58);
        const selected = blend(rgb(SKINS[skin][theme].accent), active, 0.28);
        for (const background of [surface, active, selected])
          expect(ratio(foreground, background)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

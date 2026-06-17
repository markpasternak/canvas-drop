import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND_TOKENS, RAMP_ROLE_ORDER, type ThemeName } from "./tokens.js";

/**
 * Token parity guard (DESIGN.md § token layering). Every surface must derive its
 * colour ramp from the canonical `BRAND_TOKENS` — this test fails CI if a surface
 * drifts. Modelled on the dual-dialect schema-parity test. As more surfaces are
 * routed through the brand layer, add them to SURFACES below.
 */

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Extract the body of the first CSS block matching `selector {...}`. */
function block(css: string, selector: string): string {
  const re = new RegExp(`${selector.replace(/[[\]]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const body = css.match(re)?.[1];
  if (body === undefined) throw new Error(`block not found: ${selector}`);
  return body;
}

function roleValue(blockBody: string, role: string): string | undefined {
  return blockBody.match(new RegExp(`--${role}:\\s*([^;]+);`))?.[1]?.trim();
}

const SURFACES: { name: string; css: string; light: string; dark: string }[] = [
  {
    name: "dashboard tokens.css",
    css: read("../../../../apps/dashboard/src/styles/tokens.css"),
    light: ":root",
    dark: '[data-theme="dark"]',
  },
];

describe("BRAND_TOKENS parity", () => {
  for (const surface of SURFACES) {
    for (const theme of ["light", "dark"] as ThemeName[]) {
      const selector = theme === "light" ? surface.light : surface.dark;
      const body = block(surface.css, selector);
      for (const role of RAMP_ROLE_ORDER) {
        it(`${surface.name} · ${theme} · --${role} matches BRAND_TOKENS`, () => {
          expect(roleValue(body, role)).toBe(BRAND_TOKENS[theme][role]);
        });
      }
    }
  }

  it("the app ramp contains no indigo-violet (hue ~274) — the SaaS default we rejected", () => {
    for (const surface of SURFACES) {
      expect(surface.css).not.toMatch(/oklch\([^)]*\b27[0-9]\)/);
    }
  });
});

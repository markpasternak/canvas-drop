import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCENT_ROLE_ORDER,
  SKINS,
  SYNTAX_ROLE_ORDER,
  SYNTAX_TOKENS,
  type SkinName,
} from "./skins.js";
import { BRAND_TOKENS, RAMP_ROLE_ORDER, type ThemeName } from "./tokens.js";

/**
 * Token parity guard (DESIGN.md § token layering). Every surface must derive its
 * colour ramp from the canonical `BRAND_TOKENS` — this test fails CI if a surface
 * drifts. Modelled on the dual-dialect schema-parity test.
 *
 * The dashboard `tokens.css` is hand-authored (Tailwind consumes it directly), so
 * all three of its theme blocks are checked here. The server surfaces derive their
 * ramp from `rampCssVars()` at runtime, so they can't drift on the ramp — but they
 * carry hand-written decorative colour, so they get the anti-indigo scan below.
 */

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Extract the body of the first CSS block matching `selector { ... }`. */
function block(css: string, selector: string): string {
  // Capture up to the block's own closing brace. The body holds no nested braces
  // (flat var lists), so a non-greedy match to the next `}` is exact for the
  // top-level blocks and safely over-captures the @media-nested block (the role
  // values still appear exactly once, so roleValue resolves correctly).
  const re = new RegExp(`${escapeRe(selector)}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`);
  const body = css.match(re)?.[1];
  if (body === undefined) throw new Error(`block not found: ${selector}`);
  return body;
}

function roleValue(blockBody: string, role: string): string | undefined {
  return blockBody.match(new RegExp(`--${role}:\\s*([^;]+);`))?.[1]?.trim();
}

// hue ~274 (indigo-violet) in any oklch form, including alpha (`274 / 0.3`) —
// the SaaS default the rebrand rejected.
const INDIGO = /oklch\([^)]*\b27[0-9]\b/;

const dashboardCss = read("../../../../apps/dashboard/src/styles/tokens.css");

// All three theme blocks of the hand-authored dashboard tokens.css must match
// the canonical ramp — including the OS-dark @media block (not just the toggled
// [data-theme="dark"] block), which is the OS-vs-toggle divergence we fixed.
const DASHBOARD_BLOCKS: { theme: ThemeName; selector: string; label: string }[] = [
  { theme: "light", selector: ":root", label: "light :root" },
  { theme: "dark", selector: ':root:not([data-theme="light"])', label: "OS-dark @media" },
  { theme: "dark", selector: '[data-theme="dark"]', label: "toggled [data-theme=dark]" },
];

// Server surfaces that hand-write decorative colour on top of rampCssVars().
const SERVER_SURFACES = [
  "../../../../apps/server/src/http/landing-page.ts",
  "../../../../apps/server/src/http/social-preview.ts",
  "../../../../apps/server/src/auth/guest-routes.ts",
];

describe("BRAND_TOKENS parity", () => {
  for (const { theme, selector, label } of DASHBOARD_BLOCKS) {
    const body = block(dashboardCss, selector);
    for (const role of RAMP_ROLE_ORDER) {
      it(`dashboard tokens.css · ${label} · --${role} matches BRAND_TOKENS`, () => {
        expect(roleValue(body, role)).toBe(BRAND_TOKENS[theme][role]);
      });
    }
  }

  it("dashboard tokens.css carries no indigo-violet (hue ~274) — the SaaS default we rejected", () => {
    expect(dashboardCss).not.toMatch(INDIGO);
  });

  for (const rel of SERVER_SURFACES) {
    it(`${rel.split("/").pop()} carries no indigo-violet (hue ~274)`, () => {
      expect(read(rel)).not.toMatch(INDIGO);
    });
  }
});

/**
 * Design-skin parity (expression layer). The hand-authored `[data-skin]` blocks in
 * tokens.css must match the canonical `SKINS` / `SYNTAX_TOKENS` in skins.ts — same
 * guard as the ramp, so a skin can't silently drift. editorial is the base :root.
 */
describe("design-skin parity", () => {
  // Syntax tokens are theme-scoped, skin-independent: base :root (light) + both dark blocks.
  const SYNTAX_BLOCKS: { theme: ThemeName; selector: string; label: string }[] = [
    { theme: "light", selector: ":root", label: "light :root" },
    { theme: "dark", selector: ':root:not([data-theme="light"])', label: "OS-dark @media" },
    { theme: "dark", selector: '[data-theme="dark"]', label: "toggled [data-theme=dark]" },
  ];
  for (const { theme, selector, label } of SYNTAX_BLOCKS) {
    const body = block(dashboardCss, selector);
    for (const role of SYNTAX_ROLE_ORDER) {
      it(`tokens.css · ${label} · --${role} matches SYNTAX_TOKENS`, () => {
        expect(roleValue(body, role)).toBe(SYNTAX_TOKENS[theme][role]);
      });
    }
  }

  // The editorial defaults live in the base :root; the other skins are override blocks.
  const NON_DEFAULT: SkinName[] = ["studio", "workshop", "canvas"];

  it("base :root carries the editorial display bundle (the default no-op)", () => {
    const body = block(dashboardCss, ":root");
    const d = SKINS.editorial.display;
    expect(roleValue(body, "font-display")).toBe(d.family);
    expect(roleValue(body, "display-weight")).toBe(String(d.weight));
    expect(roleValue(body, "display-tracking")).toBe(d.tracking);
    expect(roleValue(body, "radius-scale")).toBe(String(SKINS.editorial.radiusScale));
  });

  for (const skin of NON_DEFAULT) {
    const lightBody = block(dashboardCss, `:root[data-skin="${skin}"]`);

    it(`${skin} · light accent family matches SKINS`, () => {
      for (const role of ACCENT_ROLE_ORDER) {
        expect(roleValue(lightBody, role)).toBe(SKINS[skin].light[role]);
      }
    });

    it(`${skin} · display bundle + radius scale match SKINS`, () => {
      const d = SKINS[skin].display;
      expect(roleValue(lightBody, "font-display")).toBe(d.family);
      expect(roleValue(lightBody, "display-weight")).toBe(String(d.weight));
      expect(roleValue(lightBody, "display-tracking")).toBe(d.tracking);
      expect(roleValue(lightBody, "radius-scale")).toBe(String(SKINS[skin].radiusScale));
    });

    for (const selector of [
      `:root[data-skin="${skin}"]:not([data-theme="light"])`,
      `:root[data-skin="${skin}"][data-theme="dark"]`,
    ]) {
      it(`${skin} · dark accent family matches SKINS · ${selector.includes(":not") ? "OS @media" : "toggled"}`, () => {
        const body = block(dashboardCss, selector);
        for (const role of ACCENT_ROLE_ORDER) {
          expect(roleValue(body, role)).toBe(SKINS[skin].dark[role]);
        }
      });
    }
  }
});

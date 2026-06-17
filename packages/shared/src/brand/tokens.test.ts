import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

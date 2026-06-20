import { SKIN_NAMES, skinOverridesCss } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import { renderDocPage } from "../docs/render.js";
import { renderLandingPage } from "./landing-page.js";
import { renderPrivacyPage } from "./legal-pages.js";
import { skinnedHtmlTag, skinStyleCss } from "./skin-html.js";

describe("shared skin-html emitter", () => {
  it("stamps data-skin on <html> for alternates but never for editorial", () => {
    expect(skinnedHtmlTag("editorial")).toBe('<html lang="en">');
    expect(skinnedHtmlTag("studio")).toBe('<html lang="en" data-skin="studio">');
    // Extra root attrs (e.g. the legal pages' forced dark) compose before the skin attr.
    expect(skinnedHtmlTag("editorial", 'data-theme="dark"')).toBe(
      '<html lang="en" data-theme="dark">',
    );
    expect(skinnedHtmlTag("canvas", 'data-theme="dark"')).toBe(
      '<html lang="en" data-theme="dark" data-skin="canvas">',
    );
  });

  it("wraps the canonical skinOverridesCss so a surface can't drift from the source", () => {
    // The body of the helper IS the canonical emitter (no parallel copy). darkToggle is
    // threaded straight through, so the surfaces that pass it get the dark selectors.
    expect(skinStyleCss()).toContain(skinOverridesCss());
    expect(skinStyleCss({ darkToggle: true })).toContain(skinOverridesCss({ darkToggle: true }));
    // The dark-toggle variant is a strict superset (adds [data-theme="dark"] selectors).
    for (const skin of SKIN_NAMES) {
      if (skin === "editorial") continue;
      expect(skinStyleCss({ darkToggle: true })).toContain(
        `:root[data-skin="${skin}"][data-theme="dark"]`,
      );
      expect(skinStyleCss()).not.toContain(`:root[data-skin="${skin}"][data-theme="dark"]`);
    }
  });

  it("every server surface emits the SAME override blocks from the shared emitter (no drift)", () => {
    // Landing is OS-only (no dark toggle); docs + legal expose/force a theme so they carry
    // the dark-toggle variant. The base override block is identical across all three.
    const base = skinOverridesCss();
    const landing = renderLandingPage("https://x", "oidc", false, "studio");
    const docs = renderDocPage("", "", "studio") ?? "";
    const legal = renderPrivacyPage("", "studio");
    for (const html of [landing, docs, legal]) {
      expect(html).toContain(':root[data-skin="studio"]');
      expect(html).toContain(':root[data-skin="workshop"]');
      expect(html).toContain(':root[data-skin="canvas"]');
    }
    // The landing ships exactly the no-dark-toggle emitter output.
    expect(landing).toContain(base);
  });
});

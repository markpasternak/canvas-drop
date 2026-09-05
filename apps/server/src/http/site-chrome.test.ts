import { LOGO_PATHS, SKIN_NAMES } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import { renderDocPage } from "../docs/render.js";
import { renderLandingPage } from "./landing-page.js";
import { renderPrivacyPage, renderTermsPage } from "./legal-pages.js";
import { siteBrand } from "./site-chrome.js";

describe("public page chrome", () => {
  it.each(SKIN_NAMES)("keeps the logo, navigation and theme controls consistent in %s", (skin) => {
    for (const html of [
      renderLandingPage("https://x", "oidc", false, skin),
      renderDocPage("quickstart", "https://x", skin) ?? "",
      renderPrivacyPage("https://x", skin),
      renderTermsPage("https://x", skin),
    ]) {
      expect(html).toContain(siteBrand());
      expect(html).toContain(LOGO_PATHS.frame.d);
      expect(html).toContain('aria-label="Primary"');
      expect(html).toContain('aria-label="Footer"');
      expect(html).toContain('href="#main-content"');
      expect(html).toContain('id="main-content"');
      expect(html.slice(0, html.indexOf("</head>"))).toMatch(/src="\/docs\/theme.js\?v=[a-f0-9]+"/);
      expect(html).toContain('data-theme-choice="light"');
      expect(html).toContain('data-theme-choice="dark"');
      expect(html.match(/<html[^>]*>/)?.[0]).not.toContain("data-theme");
    }
  });

  it("identifies the current document and provides a usable no-JS mobile menu", () => {
    const html = renderDocPage("sdk/kv") ?? "";
    expect(html).toContain('href="/docs" aria-current="location"');
    expect(html).toContain('href="/docs/sdk/kv" aria-current="page"');
    expect(html).toContain('id="docs-navigation" open');
    expect(html).toContain("<summary>Browse documentation</summary>");
    expect(html).toMatch(/src="\/docs\/nav.js\?v=[a-f0-9]+"/);
    expect(html).not.toContain('id="nav-toggle"');
  });

  it("marks the current legal page without changing the policy date", () => {
    expect(renderPrivacyPage()).toContain('href="/privacy" aria-current="page">Privacy Policy');
    expect(renderTermsPage()).toContain('href="/terms" aria-current="page">Terms of Service');
    expect(renderPrivacyPage()).toContain("Last updated 14 June 2026");
  });
});

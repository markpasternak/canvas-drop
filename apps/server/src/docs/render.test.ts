import { describe, expect, it } from "vitest";
import { DOC_PAGES, SEARCH_INDEX } from "./generated-content.js";
import { hasDocPage, renderDocPage } from "./render.js";

describe("docs render", () => {
  it("renders the index page with the brand and search box", () => {
    const html = renderDocPage("");
    expect(html).not.toBeNull();
    expect(html).toContain("canvas-drop");
    expect(html).toContain('id="docs-search"');
    expect(html).toContain('src="/docs/search.js"');
    // A way back to the dashboard from the public docs site.
    expect(html).toContain('href="/" class="to-app"');
  });

  it("renders the theme switch and loads the theme client before paint", () => {
    const html = renderDocPage("") ?? "";
    // The segmented switch with all three choices, matching the dashboard.
    expect(html).toContain("data-theme-switch");
    expect(html).toContain('data-theme-choice="system"');
    expect(html).toContain('data-theme-choice="light"');
    expect(html).toContain('data-theme-choice="dark"');
    // Loaded from <head> (before the body) so the stored theme applies pre-paint.
    const headEnd = html.indexOf("</head>");
    expect(headEnd).toBeGreaterThan(-1);
    expect(html.slice(0, headEnd)).toContain('src="/docs/theme.js"');
    // The manual override honors the same data-theme attribute as the app.
    expect(html).toContain('[data-theme="dark"]');
  });

  it("marks the current page with aria-current and renders prev/next", () => {
    const html = renderDocPage("sdk/kv") ?? "";
    expect(html).toContain('href="/docs/sdk/kv" aria-current="page"');
    expect(html).toContain('class="prevnext"');
  });

  it("emits absolute Open Graph + Twitter share tags from the given origin", () => {
    const html = renderDocPage("sdk/kv", "https://x.example.test") ?? "";
    expect(html).toContain('property="og:image" content="https://x.example.test/og.png"');
    expect(html).toContain('property="og:url" content="https://x.example.test/docs/sdk/kv"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain("og:image:width");
  });

  it("returns null for an unknown path", () => {
    expect(renderDocPage("nope/nope")).toBeNull();
    expect(hasDocPage("nope/nope")).toBe(false);
    expect(hasDocPage("")).toBe(true);
  });

  it("keeps the search index in lockstep with the page set (single source)", () => {
    expect(SEARCH_INDEX.length).toBe(DOC_PAGES.length);
    expect(new Set(SEARCH_INDEX.map((e) => e.path))).toEqual(new Set(DOC_PAGES.map((p) => p.path)));
  });
});

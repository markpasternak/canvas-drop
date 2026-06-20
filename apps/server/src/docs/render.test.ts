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

describe("docs render — design skin", () => {
  it("omits data-skin on <html> for the default editorial skin (mirrors the landing)", () => {
    const html = renderDocPage("", "", "editorial") ?? "";
    // editorial is the attribute-free base; the <html> tag carries no skin attribute.
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('data-skin="editorial"');
  });

  it("stamps the chosen skin on <html> and ships the skin override CSS (incl. dark toggle)", () => {
    const html = renderDocPage("", "", "studio") ?? "";
    expect(html).toContain('data-skin="studio"');
    // Override blocks from the canonical shared emitter — and because the docs expose a
    // theme switch, the [data-theme="dark"] skin selectors must be present too.
    expect(html).toContain(':root[data-skin="studio"]');
    expect(html).toContain(':root[data-skin="workshop"]');
    expect(html).toContain(':root[data-skin="studio"][data-theme="dark"]');
  });

  it("re-voices headings through --font-display so a skin's display font applies", () => {
    const html = renderDocPage("", "", "editorial") ?? "";
    // Headings read the skinnable display face (not the hard-coded serif), and the
    // editorial default + the self-hosted display faces are present.
    expect(html).toContain("font-family: var(--font-display)");
    expect(html).toContain("--font-display: var(--font-serif)");
    expect(html).toContain("/fonts/geist-mono-latin-wght-normal.woff2");
  });
});

describe("docs render — mermaid diagrams", () => {
  it("renders the security-model request-flow diagram as a .mermaid block", () => {
    const html = renderDocPage("self-hosting/security-model") ?? "";
    expect(html).toContain('class="mermaid"');
    expect(html).toContain("flowchart TD");
    // The diagram source is HTML-escaped (inert text), never live markup.
    expect(html).toContain("--&gt;");
  });

  it("lazily loads the self-hosted mermaid renderer ONLY on pages with a diagram", () => {
    const withDiagram = renderDocPage("self-hosting/security-model") ?? "";
    const withoutDiagram = renderDocPage("sdk/kv") ?? "";
    // The bundle URL carries a content-hash cache-bust (?v=…) so the immutable
    // cache can't strand a returning visitor on a stale renderer.
    expect(withDiagram).toMatch(/<script src="\/docs\/mermaid\.js\?v=[0-9a-f]+" defer><\/script>/);
    expect(withoutDiagram).not.toContain('<script src="/docs/mermaid.js');
  });
});

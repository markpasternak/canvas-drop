import { describe, expect, it } from "vitest";
import { DOC_PAGES, SEARCH_INDEX } from "./generated-content.js";
import { hasDocPage, renderDocPage } from "./render.js";

describe("docs render", () => {
  it("renders the index page with the brand and search box", () => {
    const html = renderDocPage("");
    expect(html).not.toBeNull();
    expect(html).toContain("Canvasdrop");
    expect(html).toContain('id="docs-search"');
    expect(html).toContain('src="/docs/search.js"');
  });

  it("marks the current page with aria-current and renders prev/next", () => {
    const html = renderDocPage("sdk/kv") ?? "";
    expect(html).toContain('href="/docs/sdk/kv" aria-current="page"');
    expect(html).toContain('class="prevnext"');
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

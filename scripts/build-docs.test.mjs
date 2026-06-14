import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./build-docs.mjs";

describe("build-docs renderMarkdown", () => {
  it("extracts the title from the first H1", () => {
    const { title } = renderMarkdown("# My Page\n\nbody");
    expect(title).toBe("My Page");
  });

  it("emits anchor ids on H2/H3 and collects them", () => {
    const { html, headings } = renderMarkdown("# T\n\n## First Section\n\n### Sub Part");
    expect(html).toContain('<h2 id="first-section">');
    expect(html).toContain('<h3 id="sub-part">');
    expect(headings).toEqual([
      { id: "first-section", text: "First Section", level: 2 },
      { id: "sub-part", text: "Sub Part", level: 3 },
    ]);
  });

  it("highlights fenced code blocks at build time", () => {
    const { html } = renderMarkdown("# T\n\n```js\nconst x = 1;\n```");
    expect(html).toContain('class="hljs');
    expect(html).toContain("hljs-keyword"); // `const` highlighted
  });

  it("strips raw <script> and event handlers (sanitization)", () => {
    const { html } = renderMarkdown(
      '# T\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">',
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
  });

  it("strips javascript: and data: URL schemes from links and images", () => {
    const { html } = renderMarkdown("# T\n\n[click](javascript:alert(1)) ![x](data:text/html,bad)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
  });

  it("de-duplicates anchor ids when a page repeats a heading", () => {
    const { html, headings } = renderMarkdown("# T\n\n## Limits\n\nx\n\n## Limits\n\ny");
    expect(html).toContain('<h2 id="limits">');
    expect(html).toContain('<h2 id="limits-2">');
    expect(headings.map((h) => h.id)).toEqual(["limits", "limits-2"]);
  });

  it("rewrites asset-relative image links to /docs/assets/*", () => {
    const { html } = renderMarkdown("# T\n\n![shot](assets/dash.webp)");
    expect(html).toContain('src="/docs/assets/dash.webp"');
  });

  it("leaves absolute and external links untouched", () => {
    const { html } = renderMarkdown("# T\n\n![ext](https://example.com/x.png)");
    expect(html).toContain('src="https://example.com/x.png"');
  });
});

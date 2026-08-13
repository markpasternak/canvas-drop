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

  it("emits ```mermaid blocks as a .mermaid container (not hljs-highlighted)", () => {
    const { html } = renderMarkdown("# T\n\n```mermaid\nflowchart TD\n  A --> B\n```");
    expect(html).toContain('<pre class="mermaid">');
    // The diagram source survives as text for the client renderer; it is NOT run
    // through highlight.js (no hljs token classes wrapping the DSL).
    expect(html).toContain("flowchart TD");
    expect(html).not.toContain('class="hljs');
  });

  it("escapes mermaid diagram source so it survives sanitization as inert text", () => {
    // Arrows/labels carry `<`, `>`, `&` — the build escapes them and sanitize-html keeps
    // the <pre class="mermaid"> wrapper, so no raw markup reaches the DOM pre-render.
    const { html } = renderMarkdown('# T\n\n```mermaid\nflowchart LR\n  A -->|"x<b>"| B\n```');
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("--&gt;"); // arrow escaped
    expect(html).toContain("&lt;b&gt;"); // would-be tag escaped, never a live <b>
    expect(html).not.toContain("<b>");
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

describe("build-docs text extraction", () => {
  it("does not double-unescape entities into markup", () => {
    // `&amp;lt;b&amp;gt;` is the author writing the literal text `&lt;b&gt;`.
    // Unescaping `&amp;` before `&lt;` turned it into a real `<b>` tag — the
    // CodeQL js/double-escaping finding. `&amp;` must be resolved last.
    const { headings, text } = renderMarkdown("# T\n\n## A &amp;lt;b&amp;gt; tag");
    expect(headings[0].text).toBe("A &lt;b&gt; tag");
    expect(text).not.toContain("<b>");
  });

  it("still unescapes ordinary entities once", () => {
    const { headings } = renderMarkdown("# T\n\n## Tom &amp; Jerry &lt;here&gt;");
    expect(headings[0].text).toBe("Tom & Jerry <here>");
  });

  it("extracts plain text, leaving escaping to whoever embeds it", () => {
    // stripTags produces TEXT, so unescaped `<` in the result is correct — this
    // feeds the search index and (via summarize) the og:description, and it is
    // ogMeta that escapes it for HTML. See social-meta.test.ts for that half.
    const { text } = renderMarkdown("# T\n\n<p><<b>script>alert(1)<</b>/script></p>");
    expect(text).toContain("<script>");
    expect(text).not.toContain("&lt;");
  });

  it("drops HTML tags rather than leaking their markup into the text", () => {
    const { text } = renderMarkdown("# T\n\n<p>hello <em>there</em></p>");
    expect(text).toBe("T hello there");
  });
});

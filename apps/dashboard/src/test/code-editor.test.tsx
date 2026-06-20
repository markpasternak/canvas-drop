import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeEditor, cdHighlightStyle } from "../components/CodeEditor.js";

/**
 * Guards the brand-tokenized highlighting (R17 polish): the editor must mount with the
 * `--syn-*`-backed HighlightStyle (an invalid Lezer tag would throw at module load), and
 * render the document. The colours themselves are CSS vars resolved at runtime, so we
 * assert the wiring, not pixels.
 */
describe("CodeEditor — brand-tokenized highlighting", () => {
  it("maps Lezer tags to the --syn-* design tokens (colors resolve from the system)", () => {
    // Building at all proves every mapped Lezer tag is valid (HighlightStyle.define throws
    // on an unknown tag). The generated CSS proves the colors are wired to the brand
    // tokens — not a fixed palette — so they track theme + skin with no JS recompute.
    const rules = cdHighlightStyle.module?.getRules() ?? "";
    expect(rules).toContain("var(--syn-keyword)");
    expect(rules).toContain("var(--syn-string)");
    expect(rules).toContain("var(--syn-comment)");
    expect(rules).toContain("var(--syn-tag)");
  });

  it("mounts with the highlighting extension and renders the document", () => {
    render(<CodeEditor path="script.js" value="const answer = 42;" onChange={vi.fn()} readOnly />);
    const host = document.querySelector('[data-testid="code-editor"]');
    expect(host).not.toBeNull();
    // CodeMirror renders the doc into .cm-content; the source text must be present.
    expect(host?.querySelector(".cm-content")?.textContent).toContain("const answer");
  });
});

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { cdHighlightStyle, CodeEditor } from "../components/CodeEditor.js";

/**
 * Guards the brand-tokenized highlighting (R17 polish): the editor must mount with the
 * `--syn-*`-backed HighlightStyle (an invalid Lezer tag would throw at module load), and
 * render the document. The colours themselves are CSS vars resolved at runtime, so we
 * assert the wiring, not pixels.
 */
describe("CodeEditor — brand-tokenized highlighting", () => {
  it("compiles a HighlightStyle from the --syn-* tokens", () => {
    // HighlightStyle.define throws on an unknown tag; reaching here means every mapped
    // Lezer tag is valid and the style object built.
    expect(cdHighlightStyle).toBeTruthy();
    expect(typeof cdHighlightStyle).toBe("object");
  });

  it("mounts with the highlighting extension and renders the document", () => {
    render(
      <CodeEditor path="script.js" value="const answer = 42;" onChange={vi.fn()} readOnly />,
    );
    const host = document.querySelector('[data-testid="code-editor"]');
    expect(host).not.toBeNull();
    // CodeMirror renders the doc into .cm-content; the source text must be present.
    expect(host?.querySelector(".cm-content")?.textContent).toContain("const answer");
  });
});

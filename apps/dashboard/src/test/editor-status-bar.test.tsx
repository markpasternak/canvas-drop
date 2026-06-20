import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorStatusBar } from "../components/EditorStatusBar.js";

/**
 * The status bar is opt-in structural chrome: always in the DOM, carrying the
 * `.cd-statusbar` gate class that base.css hides by default and reveals only for the
 * workshop/canvas skins. We assert content + the gate class (CSS visibility is a skin
 * concern verified by the cascade, not jsdom).
 */
describe("EditorStatusBar (opt-in structural chrome)", () => {
  it("renders the file + counts behind the CSS gate class", () => {
    const { container } = render(<EditorStatusBar path="index.html" fileCount={3} />);
    const bar = container.querySelector(".cd-statusbar");
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain("index.html");
    expect(bar?.textContent).toContain("3 files");
    expect(bar?.textContent).toContain("UTF-8");
  });

  it("handles no selected file + a singular count", () => {
    const { container } = render(<EditorStatusBar path={null} fileCount={1} />);
    const bar = container.querySelector(".cd-statusbar");
    expect(bar?.textContent).toContain("no file selected");
    expect(bar?.textContent).toContain("1 file");
    expect(bar?.textContent).not.toContain("1 files");
  });
});

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OnPageEditor } from "../components/OnPageEditor.js";

/** Dispatch a window 'message' with a forced `source` (jsdom won't set it from init). */
function postFrom(source: unknown, data: unknown) {
  const evt = new MessageEvent("message", { data });
  Object.defineProperty(evt, "source", { value: source });
  window.dispatchEvent(evt);
}

function renderEditor(onSave = vi.fn()) {
  render(<OnPageEditor canvasId="c1" htmlPath="index.html" saving={false} onSave={onSave} />);
  const iframe = document.querySelector("iframe") as HTMLIFrameElement;
  return { onSave, iframe };
}

describe("OnPageEditor message → save round-trip", () => {
  it("saves the HTML a cd-onpage message posts from the iframe", () => {
    const { onSave, iframe } = renderEditor();
    postFrom(iframe.contentWindow, { type: "cd-onpage", html: "<h1>edited</h1>" });
    expect(onSave).toHaveBeenCalledWith("<h1>edited</h1>");
  });

  it("ignores a cd-onpage message from a window that isn't the iframe (source guard)", () => {
    const { onSave } = renderEditor();
    // A different window (e.g. another tab/frame) must not be able to drive a save.
    postFrom(window, { type: "cd-onpage", html: "<h1>spoofed</h1>" });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("ignores messages of other types from the iframe", () => {
    const { onSave, iframe } = renderEditor();
    postFrom(iframe.contentWindow, { type: "something-else", html: "x" });
    postFrom(iframe.contentWindow, { html: "no type" });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("uses the latest onSave (ref pattern) — a later prop is the one invoked", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <OnPageEditor canvasId="c1" htmlPath="index.html" saving={false} onSave={first} />,
    );
    rerender(<OnPageEditor canvasId="c1" htmlPath="index.html" saving={false} onSave={second} />);
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    postFrom(iframe.contentWindow, { type: "cd-onpage", html: "<p>x</p>" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("<p>x</p>");
  });
});

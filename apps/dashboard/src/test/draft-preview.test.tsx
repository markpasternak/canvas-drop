import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DraftPreview } from "../components/DraftPreview.js";
import { draftUsesScripts } from "../lib/file-kind.js";

const noop = () => {};

describe("DraftPreview script-aware rendering", () => {
  it("renders the sandboxed iframe for a static draft (usesScripts false)", () => {
    render(
      <DraftPreview
        canvasId="c1"
        refreshKey={0}
        onRefresh={noop}
        fullscreen={false}
        onToggleFullscreen={noop}
      />,
    );
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    // Isolation invariant: no allow-same-origin (R13).
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(screen.queryByTestId("preview-scripts-notice")).toBeNull();
  });

  it("swaps the frame for a notice + full-preview link when the draft runs JS", () => {
    render(
      <DraftPreview
        canvasId="c1"
        refreshKey={0}
        onRefresh={noop}
        fullscreen={false}
        onToggleFullscreen={noop}
        usesScripts
      />,
    );
    // No sandboxed iframe — it can't run the JS faithfully.
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByTestId("preview-scripts-notice")).toBeInTheDocument();
    // Prominent CTA points at the top-level (non-sandboxed) preview, new tab. Exact
    // name so it doesn't also match the "Open full preview in new tab" icon link.
    const cta = screen.getByRole("link", { name: "Open full preview" });
    expect(cta).toHaveAttribute("href", "/api/canvases/c1/preview/");
    expect(cta).toHaveAttribute("target", "_blank");
  });

  it("hides refresh/fullscreen controls in the JS notice state", () => {
    const onRefresh = vi.fn();
    render(
      <DraftPreview
        canvasId="c1"
        refreshKey={0}
        onRefresh={onRefresh}
        fullscreen={false}
        onToggleFullscreen={noop}
        usesScripts
      />,
    );
    expect(screen.queryByRole("button", { name: "Refresh preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Full screen preview" })).toBeNull();
    // Open-in-new-tab (icon link) stays available.
    expect(screen.getByRole("link", { name: "Open full preview in new tab" })).toBeInTheDocument();
  });
});

describe("draftUsesScripts detection", () => {
  it("detects .js files by extension and by MIME", () => {
    expect(draftUsesScripts([{ path: "index.html", mime: "text/html" }])).toBe(false);
    expect(
      draftUsesScripts([
        { path: "index.html", mime: "text/html" },
        { path: "js/main.js", mime: "text/javascript" },
      ]),
    ).toBe(true);
    // MIME catches a script even if the extension is unusual.
    expect(draftUsesScripts([{ path: "bundle", mime: "application/javascript" }])).toBe(true);
  });

  it("is false for a purely static draft (html/css/images only)", () => {
    expect(
      draftUsesScripts([
        { path: "index.html", mime: "text/html" },
        { path: "styles.css", mime: "text/css" },
        { path: "logo.png", mime: "image/png" },
      ]),
    ).toBe(false);
  });
});

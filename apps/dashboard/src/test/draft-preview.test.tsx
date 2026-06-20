import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("starts on a notice with Run preview + full-preview link when the draft runs JS", () => {
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
    // The frame isn't mounted until the owner opts in (Run preview).
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByTestId("preview-scripts-notice")).toBeInTheDocument();
    // Opt-in affordance to run the draft in the existing sandbox.
    expect(screen.getByRole("button", { name: "Run preview" })).toBeInTheDocument();
    // And the top-level (non-sandboxed) preview link remains. Exact name so it doesn't
    // also match the "Open full preview in new tab" icon link.
    const cta = screen.getByRole("link", { name: "Open full preview" });
    expect(cta).toHaveAttribute("href", "/api/canvases/c1/preview/");
    expect(cta).toHaveAttribute("target", "_blank");
  });

  it("runs a scripted draft in the SAME sandbox after Run preview (isolation preserved)", async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByRole("button", { name: "Run preview" }));

    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    // Critical: the opt-in must NOT relax the sandbox — no allow-same-origin (R13).
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    // The notice is gone; frame controls (refresh/fullscreen) are now available.
    expect(screen.queryByTestId("preview-scripts-notice")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Full screen preview" })).toBeInTheDocument();
  });

  it("hides refresh/fullscreen controls in the JS notice state (before Run preview)", () => {
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

describe("DraftPreview live-status ribbon", () => {
  it("shows a Live ribbon with an Open-full link while the frame is rendering (static draft)", () => {
    render(
      <DraftPreview
        canvasId="c1"
        refreshKey={0}
        onRefresh={noop}
        fullscreen={false}
        onToggleFullscreen={noop}
      />,
    );
    expect(screen.getByText("Live preview")).toBeInTheDocument();
    const openFull = screen.getByRole("link", { name: "Open full" });
    expect(openFull).toHaveAttribute("href", "/api/canvases/c1/preview/");
    expect(openFull).toHaveAttribute("target", "_blank");
  });

  it("includes the canvas-skin window-dots in the header (CSS-gated, present in the DOM)", () => {
    const { container } = render(
      <DraftPreview
        canvasId="c1"
        refreshKey={0}
        onRefresh={noop}
        fullscreen={false}
        onToggleFullscreen={noop}
      />,
    );
    expect(container.querySelector(".cd-window-dots")).not.toBeNull();
  });

  it("has no Live ribbon in the JS-notice state (frame not yet running)", () => {
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
    expect(screen.queryByText("Live preview")).toBeNull();
  });

  it("reveals the Live ribbon once a scripted draft is run", async () => {
    const user = userEvent.setup();
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
    expect(screen.queryByText("Live preview")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Run preview" }));
    expect(screen.getByText("Live preview")).toBeInTheDocument();
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

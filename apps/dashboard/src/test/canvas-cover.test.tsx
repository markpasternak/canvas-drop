import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CanvasCover, coverCrossOrigin, previewCoverUrl } from "../components/CanvasCover.js";

describe("previewCoverUrl (plan 004 / U8)", () => {
  it("builds the access-gated preview route URL for a rendition", () => {
    expect(previewCoverUrl("https://app.canvas-drop.com/c/s/")).toBe(
      "https://app.canvas-drop.com/c/s/__canvasdrop_preview?rendition=card&cors=1",
    );
    expect(previewCoverUrl("https://s.canvas-drop.com", "og")).toBe(
      "https://s.canvas-drop.com/__canvasdrop_preview?rendition=og&cors=1",
    );
  });
});

describe("CanvasCover (plan 004 / U8)", () => {
  it("renders the preview <img> when a URL is given", () => {
    const { container } = render(<CanvasCover seed="cv1" previewUrl="https://x/preview" />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://x/preview");
  });

  it("falls back to the generative cover when no preview URL is given", () => {
    const { container } = render(<CanvasCover seed="cv1" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("div[aria-hidden]")).not.toBeNull();
  });

  it("falls back to the generative cover when the preview image fails to load (off / not captured)", () => {
    const { container } = render(<CanvasCover seed="cv1" previewUrl="https://x/preview" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    if (img) fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull(); // swapped to generative art
    expect(container.querySelector("div[aria-hidden]")).not.toBeNull();
  });

  it("forwards `plain` to the fallback — the carded cover is pure background (no baked text)", () => {
    const { container, queryByText } = render(
      <CanvasCover
        seed="cv1"
        title="My Live Dashboard"
        type="templates"
        status="published"
        plain
      />,
    );
    // No preview URL → generative fallback, but in pure-background mode: no overlay text.
    expect(queryByText("My Live Dashboard")).toBeNull();
    expect(container.querySelector("[data-cover-type]")).toBeNull();
    expect(container.querySelector("[data-cover-status]")).toBeNull();
    expect(container.querySelector("[data-cover-plain]")).not.toBeNull();
  });

  it("falls back to the CONTENT-AWARE generative cover (title + marker) on image error", () => {
    const { container, getByText } = render(
      <CanvasCover
        seed="cv1"
        previewUrl="https://x/preview"
        title="My Live Dashboard"
        type="templates"
        status="published"
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    if (img) fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    // The fallback overlay carries the threaded title + type/status markers.
    expect(getByText("My Live Dashboard")).toBeTruthy();
    expect(container.querySelector("[data-cover-type='templates']")).not.toBeNull();
    expect(container.querySelector("[data-cover-status='published']")).not.toBeNull();
  });
});

// vitest's jsdom page is http://localhost:3000/ by default.
describe("coverCrossOrigin (audit #24)", () => {
  it("requests a cover on another host with credentials (subdomain mode)", () => {
    expect(coverCrossOrigin("https://my-canvas.canvases.example.com/__canvasdrop_preview")).toBe(
      "use-credentials",
    );
    const { container } = render(
      <CanvasCover seed="cv1" previewUrl="https://my-canvas.canvases.example.com/p" />,
    );
    expect(container.querySelector("img")?.getAttribute("crossorigin")).toBe("use-credentials");
  });

  it("leaves same-host covers alone, including another port (path mode, dev proxy)", () => {
    const host = window.location.hostname;
    expect(coverCrossOrigin(`http://${host}:3000/c/x/__canvasdrop_preview`)).toBeUndefined();
    expect(coverCrossOrigin(`http://${host}:5173/c/x/__canvasdrop_preview`)).toBeUndefined();
    expect(coverCrossOrigin("/c/x/__canvasdrop_preview")).toBeUndefined();
  });
});

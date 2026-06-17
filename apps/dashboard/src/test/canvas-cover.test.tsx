import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CanvasCover, previewCoverUrl } from "../components/CanvasCover.js";

describe("previewCoverUrl (plan 004 / U8)", () => {
  it("builds the access-gated preview route URL for a rendition", () => {
    expect(previewCoverUrl("https://app.canvas-drop.com/c/s/")).toBe(
      "https://app.canvas-drop.com/c/s/__canvasdrop_preview?rendition=card",
    );
    expect(previewCoverUrl("https://s.canvas-drop.com", "og")).toBe(
      "https://s.canvas-drop.com/__canvasdrop_preview?rendition=og",
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
});

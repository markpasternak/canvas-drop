import { describe, expect, it } from "vitest";
import { coverCrossOrigin } from "../components/CanvasCover.js";

// vitest's jsdom page is http://localhost:3000/ by default.
describe("coverCrossOrigin", () => {
  it("requests a cover on another host with credentials (subdomain mode)", () => {
    expect(coverCrossOrigin("https://my-canvas.canvases.example.com/__canvasdrop_preview")).toBe(
      "use-credentials",
    );
  });

  it("leaves same-host covers alone, including another port (path mode, dev proxy)", () => {
    const host = window.location.hostname;
    expect(coverCrossOrigin(`http://${host}:3000/c/x/__canvasdrop_preview`)).toBeUndefined();
    expect(coverCrossOrigin(`http://${host}:5173/c/x/__canvasdrop_preview`)).toBeUndefined();
    expect(coverCrossOrigin("/c/x/__canvasdrop_preview")).toBeUndefined();
  });
});

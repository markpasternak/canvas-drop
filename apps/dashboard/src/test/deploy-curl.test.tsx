import { describe, expect, it } from "vitest";
import { deployCurl } from "../lib/deploy-curl.js";

describe("deployCurl", () => {
  it("targets the canvas's /v1 deploy endpoint at the URL origin (path-mode URL)", () => {
    const snippet = deployCurl({
      url: "https://canvas-drop.example.com/c/my-slug/",
      id: "cnv_123",
      apiKey: "$CANVAS_DROP_KEY",
    });
    // Only the origin is used — the slug path is dropped.
    expect(snippet).toContain(
      'curl -X PUT "https://canvas-drop.example.com/v1/canvases/cnv_123/deploy"',
    );
    expect(snippet).not.toContain("/c/my-slug");
  });

  it("derives the origin from a subdomain-mode URL", () => {
    const snippet = deployCurl({
      url: "https://my-slug.canvas-drop.example.com/",
      id: "cnv_abc",
      apiKey: "$CANVAS_DROP_KEY",
    });
    expect(snippet).toContain(
      'curl -X PUT "https://my-slug.canvas-drop.example.com/v1/canvases/cnv_abc/deploy"',
    );
  });

  it("embeds the API key in the Authorization header", () => {
    const withReal = deployCurl({
      url: "https://x.example.com/",
      id: "cnv_1",
      apiKey: "cdk_live_secret",
    });
    expect(withReal).toContain('-H "Authorization: Bearer cdk_live_secret"');

    const withPlaceholder = deployCurl({
      url: "https://x.example.com/",
      id: "cnv_1",
      apiKey: "$CANVAS_DROP_KEY",
    });
    expect(withPlaceholder).toContain('-H "Authorization: Bearer $CANVAS_DROP_KEY"');
  });

  it("uploads the zip via --data-binary", () => {
    const snippet = deployCurl({ url: "https://x.example.com/", id: "cnv_1", apiKey: "k" });
    expect(snippet).toContain("--data-binary @site.zip");
  });
});

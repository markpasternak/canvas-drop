import { type Config, loadConfig } from "@canvas-drop/shared";
import type { Manifest } from "@canvas-drop/shared/db";
import { describe, expect, it } from "vitest";
import { assetPathFor, resolveAsset } from "./asset-resolver.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const subConfig: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvases.example.com",
});

describe("assetPathFor", () => {
  it("strips the /c/{slug} prefix in path mode", () => {
    expect(assetPathFor(config, "abc", "/c/abc/index.html")).toBe("index.html");
    expect(assetPathFor(config, "abc", "/c/abc/")).toBe("");
    expect(assetPathFor(config, "abc", "/c/abc/a/b.css")).toBe("a/b.css");
  });

  it("uses the raw path (no /c/ prefix) in subdomain mode", () => {
    expect(assetPathFor(subConfig, "abc", "/index.html")).toBe("index.html");
    expect(assetPathFor(subConfig, "abc", "/")).toBe("");
    expect(assetPathFor(subConfig, "abc", "/a/b.css")).toBe("a/b.css");
  });
});

describe("resolveAsset", () => {
  const manifest: Manifest = {
    "index.html": { size: 1, hash: "h1", mime: "text/html" },
    "app.js": { size: 1, hash: "h2", mime: "text/javascript" },
    "sub/index.html": { size: 1, hash: "h3", mime: "text/html" },
  };
  it("exact hit", () => {
    expect(resolveAsset(manifest, "app.js", false)?.path).toBe("app.js");
  });
  it("root and directory resolve to index.html", () => {
    expect(resolveAsset(manifest, "", false)?.path).toBe("index.html");
    expect(resolveAsset(manifest, "sub/", false)?.path).toBe("sub/index.html");
  });
  it("unknown path → null without SPA fallback, root index with it", () => {
    expect(resolveAsset(manifest, "missing", false)).toBeNull();
    expect(resolveAsset(manifest, "missing", true)?.path).toBe("index.html");
  });
  it("root with no index.html but a single HTML file serves that file", () => {
    const single: Manifest = {
      "POST-S~3 (1).HTM": { size: 1, hash: "h", mime: "text/html; charset=utf-8" },
      "style.css": { size: 1, hash: "h2", mime: "text/css" },
    };
    expect(resolveAsset(single, "", false)?.path).toBe("POST-S~3 (1).HTM");
  });
  it("root stays 404 when there are several HTML files and no index.html (ambiguous)", () => {
    const many: Manifest = {
      "a.html": { size: 1, hash: "h1", mime: "text/html" },
      "b.html": { size: 1, hash: "h2", mime: "text/html" },
    };
    expect(resolveAsset(many, "", false)).toBeNull();
  });
  it("SPA fallback serves the root entry for unknown paths — index.html or a lone HTML file", () => {
    expect(resolveAsset(manifest, "route/deep", true)?.path).toBe("index.html");
    const single: Manifest = {
      "app.html": { size: 1, hash: "h", mime: "text/html" },
      "main.js": { size: 1, hash: "h2", mime: "text/javascript" },
    };
    expect(resolveAsset(single, "route/deep", false)).toBeNull(); // off → 404
    expect(resolveAsset(single, "route/deep", true)?.path).toBe("app.html");
    const many: Manifest = {
      "a.html": { size: 1, hash: "h1", mime: "text/html" },
      "b.html": { size: 1, hash: "h2", mime: "text/html" },
    };
    expect(resolveAsset(many, "route/deep", true)).toBeNull();
  });
});

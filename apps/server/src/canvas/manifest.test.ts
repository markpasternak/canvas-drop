import type { Manifest } from "@canvas-drop/shared/db";
import { describe, expect, it } from "vitest";
import { rootEntry, soleHtmlEntry } from "./manifest.js";

const html = (): { size: number; hash: string; mime: string } => ({
  size: 1,
  hash: "h",
  mime: "text/html; charset=utf-8",
});
const asset = (mime: string) => ({ size: 1, hash: "h", mime });

describe("soleHtmlEntry", () => {
  it("returns the path when exactly one HTML file exists, ignoring non-HTML", () => {
    const m: Manifest = { "page.html": html(), "style.css": asset("text/css") };
    expect(soleHtmlEntry(m)).toBe("page.html");
  });
  it("returns null for zero or several HTML files", () => {
    expect(soleHtmlEntry({ "a.css": asset("text/css") })).toBeNull();
    expect(soleHtmlEntry({ "a.html": html(), "b.html": html() })).toBeNull();
  });
});

describe("rootEntry", () => {
  it("prefers index.html", () => {
    expect(rootEntry({ "index.html": html(), "other.html": html() })).toEqual({
      path: "index.html",
      reason: "index",
    });
  });
  it("falls back to a single HTML file", () => {
    expect(rootEntry({ "POST-S~3 (1).HTM": html(), "a.css": asset("text/css") })).toEqual({
      path: "POST-S~3 (1).HTM",
      reason: "single",
    });
  });
  it("is ambiguous with several HTML files and no index", () => {
    expect(rootEntry({ "a.html": html(), "b.html": html() })).toEqual({
      path: null,
      reason: "ambiguous",
    });
  });
  it("is none with no HTML at all", () => {
    expect(rootEntry({ "app.js": asset("text/javascript") })).toEqual({
      path: null,
      reason: "none",
    });
  });
});

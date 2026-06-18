import { describe, expect, it } from "vitest";
import {
  isEditableFile,
  isHtmlFile,
  isImage,
  nonEditableReason,
  normalizeDraftPath,
  singleHtmlFile,
} from "../lib/file-kind.js";

const f = (path: string, mime: string, size = 100) => ({ path, mime, size });

describe("normalizeDraftPath (client mirror of the server's normalizeEntryPath)", () => {
  it("trims and strips a leading ./ or / so it maps to the manifest key", () => {
    expect(normalizeDraftPath("  index.html  ")).toBe("index.html");
    expect(normalizeDraftPath("/assets/app.js")).toBe("assets/app.js");
    expect(normalizeDraftPath("./assets/app.js")).toBe("assets/app.js");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(normalizeDraftPath("assets\\img\\logo.png")).toBe("assets/img/logo.png");
  });

  it("returns null for a path with a .. traversal segment", () => {
    expect(normalizeDraftPath("../secret.txt")).toBeNull();
    expect(normalizeDraftPath("assets/../../secret.txt")).toBeNull();
  });

  it("returns null for an absolute path", () => {
    // Only ONE leading "./" or "/" is stripped, so "//etc" still starts with "/"
    // after normalization and is rejected.
    expect(normalizeDraftPath("//etc/passwd")).toBeNull();
  });

  it("returns null for a trailing-slash (directory) path and for empty input", () => {
    expect(normalizeDraftPath("assets/")).toBeNull();
    expect(normalizeDraftPath("")).toBeNull();
    expect(normalizeDraftPath("   ")).toBeNull();
  });

  it("returns null for dotfiles (any segment starting with a dot)", () => {
    expect(normalizeDraftPath(".env")).toBeNull();
    expect(normalizeDraftPath("config/.secret")).toBeNull();
  });
});

describe("isEditableFile (allowlist + size cap)", () => {
  it("opens recognized text/code files in the editor", () => {
    for (const [path, mime] of [
      ["index.html", "text/html"],
      ["styles/main.css", "text/css"],
      ["app.js", "text/javascript"],
      ["data.json", "application/json"],
      ["notes.md", "text/markdown"],
      ["logo.svg", "image/svg+xml"], // SVG is XML text — editable
      ["README", "text/plain"], // texty filename, no extension
    ] as const) {
      expect(isEditableFile(f(path, mime))).toBe(true);
    }
  });

  it("never opens binary/unknown types in the editor (the xlsx-crash class)", () => {
    // The server downgrades unknown extensions to text/plain — the allowlist must
    // NOT trust that, or a spreadsheet's bytes load into CodeMirror and hang the tab.
    expect(isEditableFile(f("report.xlsx", "text/plain"))).toBe(false);
    expect(isEditableFile(f("doc.docx", "application/octet-stream"))).toBe(false);
    expect(isEditableFile(f("photo.png", "image/png"))).toBe(false);
    expect(isEditableFile(f("font.woff2", "font/woff2"))).toBe(false);
    expect(isEditableFile(f("archive.zip", "application/zip"))).toBe(false);
    expect(isEditableFile(f("doc.pdf", "application/pdf"))).toBe(false);
  });

  it("treats a text file over the size cap as non-editable", () => {
    expect(isEditableFile(f("huge.txt", "text/plain", 3 * 1024 * 1024))).toBe(false);
    expect(nonEditableReason(f("huge.txt", "text/plain", 3 * 1024 * 1024))).toBe("too-large");
    expect(nonEditableReason(f("photo.png", "image/png"))).toBe("binary");
  });
});

describe("singleHtmlFile (on-page editing availability)", () => {
  it("finds the one HTML page among many asset types of every kind", () => {
    const files = [
      f("index.html", "text/html"),
      f("style.css", "text/css"),
      f("app.js", "text/javascript"),
      f("data.json", "application/json"),
      f("logo.png", "image/png"),
      f("hero.jpg", "image/jpeg"),
      f("font.woff2", "font/woff2"),
      f("clip.mp4", "video/mp4"),
      f("report.pdf", "application/pdf"),
    ];
    expect(singleHtmlFile(files)?.path).toBe("index.html");
  });

  it("works when the single HTML page isn't named index.html", () => {
    const files = [f("page.htm", "text/html"), f("style.css", "text/css")];
    expect(singleHtmlFile(files)?.path).toBe("page.htm");
  });

  it("returns null with zero HTML files (nothing to edit on-page)", () => {
    expect(singleHtmlFile([f("style.css", "text/css"), f("a.png", "image/png")])).toBeNull();
  });

  it("returns null with several HTML files (ambiguous which page)", () => {
    expect(singleHtmlFile([f("a.html", "text/html"), f("b.htm", "text/html")])).toBeNull();
  });

  it("keys on MIME (text/html), matching the server's entry resolution — not the extension", () => {
    expect(isHtmlFile(f("a.html", "text/html"))).toBe(true);
    expect(isHtmlFile(f("a.css", "text/css"))).toBe(false);
    // A lone .xhtml the server downgrades to text/plain is NOT offered for on-page
    // editing (the preview couldn't render it as the entry) — client/server agree.
    expect(isHtmlFile(f("page.xhtml", "text/plain"))).toBe(false);
    expect(singleHtmlFile([f("page.xhtml", "text/plain"), f("style.css", "text/css")])).toBeNull();
  });
});

describe("isImage", () => {
  it("is true for raster images, false for SVG (editable) and non-images", () => {
    expect(isImage(f("photo.png", "image/png"))).toBe(true);
    expect(isImage(f("pic.jpeg", "image/jpeg"))).toBe(true);
    expect(isImage(f("logo.svg", "image/svg+xml"))).toBe(false); // editable as text
    expect(isImage(f("font.woff2", "font/woff2"))).toBe(false);
    expect(isImage(f("index.html", "text/html"))).toBe(false);
  });
});

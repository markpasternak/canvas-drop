import { describe, expect, it } from "vitest";
import {
  isEditableFile,
  isHtmlFile,
  isImage,
  nonEditableReason,
  singleHtmlFile,
} from "../lib/file-kind.js";

const f = (path: string, mime: string, size = 100) => ({ path, mime, size });

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
  it("returns the lone HTML page when there's exactly one (assets allowed)", () => {
    const files = [
      f("index.html", "text/html"),
      f("style.css", "text/css"),
      f("a.png", "image/png"),
    ];
    expect(singleHtmlFile(files)?.path).toBe("index.html");
  });

  it("returns null with zero HTML files (nothing to edit on-page)", () => {
    expect(singleHtmlFile([f("style.css", "text/css")])).toBeNull();
  });

  it("returns null with several HTML files (ambiguous which page)", () => {
    expect(singleHtmlFile([f("a.html", "text/html"), f("b.htm", "text/html")])).toBeNull();
  });

  it("isHtmlFile recognizes html/htm/xhtml only", () => {
    expect(isHtmlFile(f("a.html", "text/html"))).toBe(true);
    expect(isHtmlFile(f("a.htm", "text/html"))).toBe(true);
    expect(isHtmlFile(f("a.css", "text/css"))).toBe(false);
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

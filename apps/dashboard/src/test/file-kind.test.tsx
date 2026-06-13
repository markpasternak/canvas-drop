import { describe, expect, it } from "vitest";
import { isBinaryMime, isImageMime } from "../lib/file-kind.js";

describe("isBinaryMime", () => {
  it("treats text and code types as editable (not binary)", () => {
    for (const m of [
      "text/html",
      "text/css",
      "text/javascript",
      "application/json",
      "text/markdown",
      "text/plain; charset=utf-8",
    ]) {
      expect(isBinaryMime(m)).toBe(false);
    }
  });

  it("treats media and archives as binary", () => {
    for (const m of [
      "image/png",
      "image/svg+xml",
      "font/woff2",
      "audio/mpeg",
      "video/mp4",
      "application/pdf",
      "application/zip",
      "application/octet-stream",
      "application/wasm",
    ]) {
      expect(isBinaryMime(m)).toBe(true);
    }
  });

  it("ignores a charset parameter on exact matches", () => {
    expect(isBinaryMime("application/pdf; charset=binary")).toBe(true);
  });
});

describe("isImageMime", () => {
  it("is true only for image/* types", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("image/svg+xml")).toBe(true);
    expect(isImageMime("font/woff2")).toBe(false);
    expect(isImageMime("text/html")).toBe(false);
  });
});

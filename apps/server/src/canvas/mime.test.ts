import { describe, expect, it } from "vitest";
import { isTextContentType, mimeFor } from "./mime.js";

describe("mimeFor", () => {
  it("maps known extensions to their MIME type", () => {
    expect(mimeFor("index.html").contentType).toMatch(/text\/html/);
    expect(mimeFor("app.js").contentType).toMatch(/text\/javascript/);
    expect(mimeFor("style.css").contentType).toMatch(/text\/css/);
    expect(mimeFor("logo.svg").contentType).toBe("image/svg+xml");
    expect(mimeFor("a/b/photo.png").contentType).toBe("image/png");
  });

  it("downgrades server-side executables to text/plain", () => {
    for (const f of ["x.php", "x.sh", "x.py", "x.rb", "x.exe", "x.jsp"]) {
      const r = mimeFor(f);
      expect(r.contentType).toMatch(/text\/plain/);
      expect(r.downgraded).toBe(true);
    }
  });

  it("downgrades unknown extensions to text/plain", () => {
    const r = mimeFor("mystery.zzz");
    expect(r.contentType).toMatch(/text\/plain/);
    expect(r.downgraded).toBe(true);
  });
});

describe("isTextContentType", () => {
  it("classifies text-shaped types as text (UTF-8 read-back)", () => {
    for (const ct of [
      "text/html; charset=utf-8",
      "text/css; charset=utf-8",
      "text/javascript; charset=utf-8",
      "application/json; charset=utf-8",
      "application/xml; charset=utf-8",
      "image/svg+xml", // SVG is XML text
      "text/csv; charset=utf-8",
    ]) {
      expect(isTextContentType(ct), ct).toBe(true);
    }
  });

  it("classifies binary types as non-text (base64 read-back)", () => {
    for (const ct of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "font/woff2",
      "application/wasm",
      "application/pdf",
      "video/mp4",
    ]) {
      expect(isTextContentType(ct), ct).toBe(false);
    }
  });
});

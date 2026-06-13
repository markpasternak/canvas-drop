import { describe, expect, it } from "vitest";
import { isInlineSafe, safeServeHeaders } from "./file-serving.js";

describe("safe file serving (KTD-5, §12.0 #2/#4)", () => {
  it("serves safe rasters inline", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
      expect(isInlineSafe(m)).toBe(true);
      expect(safeServeHeaders(m, "a.png")["Content-Disposition"]).toMatch(/^inline;/);
    }
  });

  it("forces SVG to attachment (image/* but scriptable — stored-XSS gate)", () => {
    expect(isInlineSafe("image/svg+xml")).toBe(false);
    expect(safeServeHeaders("image/svg+xml", "x.svg")["Content-Disposition"]).toMatch(
      /^attachment;/,
    );
  });

  it("forces HTML and unknown types to attachment", () => {
    expect(safeServeHeaders("text/html", "p.html")["Content-Disposition"]).toMatch(/^attachment;/);
    expect(safeServeHeaders("application/octet-stream", "x.bin")["Content-Disposition"]).toMatch(
      /^attachment;/,
    );
  });

  it("always sets nosniff", () => {
    expect(safeServeHeaders("image/png", "a.png")["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("sanitizes the filename so it can't inject headers", () => {
    const cd =
      safeServeHeaders("text/plain", 'evil"\r\nSet-Cookie: x=1;.txt')["Content-Disposition"] ?? "";
    expect(cd).not.toContain("\r");
    expect(cd).not.toContain("\n");
    // the ascii fallback contains no raw double-quote breaking the quoted-string
    const ascii = cd.match(/filename="([^"]*)"/)?.[1] ?? "";
    expect(ascii).not.toContain('"');
    // the unicode form round-trips the original name
    expect(cd).toContain("filename*=UTF-8''");
  });
});

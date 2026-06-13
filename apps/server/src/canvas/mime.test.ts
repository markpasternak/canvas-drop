import { describe, expect, it } from "vitest";
import { mimeFor } from "./mime.js";

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

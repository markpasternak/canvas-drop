import { describe, expect, it } from "vitest";
import { ogMeta } from "./social-meta.js";

const base = { origin: "https://canvas-drop.com", path: "/docs", title: "Docs" };

// These pin the property that actually protects the emitted tags — no raw angle
// bracket reaches an attribute value — rather than the tag strip in isolation.
// The strip is cosmetic; `escapeHtml` is what makes the output safe, so these
// hold for any strip implementation and would catch its removal.
describe("ogMeta description sanitization", () => {
  it("emits no raw markup even for nested-tag input", () => {
    const d = ogMeta({ ...base, description: "<<b>script>alert(1)<</b>/script>hi" });
    expect(d).not.toContain("<script");
    expect(d).not.toContain("</script");
  });

  it("leaves no raw angle bracket in any emitted attribute value", () => {
    const out = ogMeta({ ...base, description: '<<i>img src=x onerror="y">text' });
    for (const value of out.matchAll(/content="([^"]*)"/g)) {
      expect(value[1]).not.toMatch(/[<>]/);
    }
  });

  it("escapes the title and description into attribute-safe text", () => {
    const out = ogMeta({ ...base, title: 'A "quoted" & <b>bold</b>', description: "a & b" });
    expect(out).toContain("&amp;");
    expect(out).not.toContain('content="A "quoted"');
  });

  it("keeps ordinary prose intact and collapses whitespace", () => {
    const out = ogMeta({ ...base, description: "Deploy   small\n\nweb artifacts." });
    expect(out).toContain('content="Deploy small web artifacts."');
  });
});

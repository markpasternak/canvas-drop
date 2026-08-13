import { describe, expect, it } from "vitest";
import { ogMeta } from "./social-meta.js";

const base = { origin: "https://canvas-drop.com", path: "/docs", title: "Docs" };

describe("ogMeta description sanitization", () => {
  it("strips tags nested so a single pass would re-form them", () => {
    // A one-pass `<[^>]+>` strip removes the inner `<b>` and leaves the outer
    // fragments touching, re-forming `<script>` in the output. The strip must
    // run to a fixpoint (CodeQL js/incomplete-multi-character-sanitization).
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

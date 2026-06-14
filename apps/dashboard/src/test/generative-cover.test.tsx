import { describe, expect, it } from "vitest";
import { coverStyle } from "../components/GenerativeCover.js";

describe("coverStyle (plan 004)", () => {
  it("is deterministic — same seed yields the same art", () => {
    expect(coverStyle("canvas-abc")).toEqual(coverStyle("canvas-abc"));
  });

  it("differs across seeds", () => {
    expect(coverStyle("canvas-abc")).not.toEqual(coverStyle("canvas-xyz"));
  });

  it("is never blank — always a colour plus a layered gradient", () => {
    const s = coverStyle("anything");
    expect(s.backgroundColor).toBeTruthy();
    expect(String(s.backgroundImage)).toContain("radial-gradient");
  });
});

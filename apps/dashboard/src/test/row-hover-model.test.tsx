import { describe, expect, it } from "vitest";
import { cardHoverClass, rowHoverClass } from "../lib/row-styles.js";

/**
 * One hover model for "a canvas": cards LIFT (translate + shadow), list rows TINT
 * + BORDER (no lift). Codified in row-styles so the gallery card, the grid card,
 * and the list row never diverge. These assertions pin the shared vocabulary so a
 * future ad-hoc tweak to one surface can't silently fork the treatment.
 */
describe("canvas hover model (shared vocabulary)", () => {
  it("cards lift: translate-up + raised shadow on hover", () => {
    expect(cardHoverClass).toContain("hover:-translate-y-0.5");
    expect(cardHoverClass).toContain("hover:shadow-");
    expect(cardHoverClass).toContain("hover:border-border-strong");
  });

  it("rows tint + border, and do NOT lift", () => {
    expect(rowHoverClass).toContain("hover:bg-surface-raised");
    expect(rowHoverClass).toContain("hover:border-border-strong");
    expect(rowHoverClass).not.toContain("translate");
  });
});

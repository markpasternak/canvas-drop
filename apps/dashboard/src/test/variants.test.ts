import { describe, expect, it } from "vitest";
import { controlHeight, type Size, type Tone, type Variant } from "../components/variants.js";

describe("shared control vocabulary", () => {
  it("maps every size to its --control-* height token", () => {
    expect(controlHeight).toEqual({
      sm: "h-[var(--control-sm)]",
      md: "h-[var(--control-md)]",
      lg: "h-[var(--control-lg)]",
    });
  });

  it("covers exactly the three sizes", () => {
    const sizes: Size[] = ["sm", "md", "lg"];
    expect(Object.keys(controlHeight).sort()).toEqual([...sizes].sort());
  });

  it("documents the union members (compile-time, asserted via exhaustive maps)", () => {
    // These maps fail to compile if the unions drift, locking the vocabulary.
    const variants: Record<Variant, true> = {
      primary: true,
      secondary: true,
      ghost: true,
      danger: true,
    };
    const tones: Record<Tone, true> = {
      neutral: true,
      accent: true,
      success: true,
      warning: true,
      danger: true,
    };
    expect(Object.keys(variants)).toHaveLength(4);
    expect(Object.keys(tones)).toHaveLength(5);
  });
});

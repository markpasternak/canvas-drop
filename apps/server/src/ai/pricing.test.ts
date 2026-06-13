import { describe, expect, it } from "vitest";
import { costUsd, isPricedModel, PRICING } from "./pricing.js";

describe("ai pricing", () => {
  it("computes cost from per-MTok rates (input + output)", () => {
    // opus-4-8: $5/MTok in, $25/MTok out
    expect(costUsd("claude-opus-4-8", 1_000_000, 1_000_000)).toBeCloseTo(30, 10);
    // 1000 in + 2000 out at opus rates = 0.005 + 0.05 = 0.055
    expect(costUsd("claude-opus-4-8", 1000, 2000)).toBeCloseTo(0.055, 10);
  });

  it("keeps fractional cents (haiku, small token counts)", () => {
    // haiku-4-5: $1/MTok in, $5/MTok out → 500 in + 100 out = 0.0005 + 0.0005
    expect(costUsd("claude-haiku-4-5", 500, 100)).toBeCloseTo(0.001, 10);
  });

  it("unknown model costs 0 and is flagged unpriced (never throws)", () => {
    expect(costUsd("some-future-model", 1000, 1000)).toBe(0);
    expect(isPricedModel("some-future-model")).toBe(false);
    expect(isPricedModel("claude-sonnet-4-6")).toBe(true);
  });

  it("every priced model has positive rates", () => {
    for (const [model, rate] of Object.entries(PRICING)) {
      expect(rate.inputPerMTok, model).toBeGreaterThan(0);
      expect(rate.outputPerMTok, model).toBeGreaterThan(0);
    }
  });
});

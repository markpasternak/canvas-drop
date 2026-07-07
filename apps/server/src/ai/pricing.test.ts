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

  it("prices 5-minute prompt-cache writes at 1.25x and reads at 0.1x input", () => {
    // haiku-4-5: 500 uncached input, 200 cache-write input, 300 cache-read input.
    // 500*1 + 200*1.25 + 300*0.1 = 780 token-rate units = $0.00078.
    expect(costUsd("claude-haiku-4-5", 1000, 0, 200, 300)).toBeCloseTo(0.00078, 10);
    // sonnet-4-6: 1000 uncached + 1000 write + 1000 read + 500 output.
    // input: (1000*3 + 1000*3.75 + 1000*0.3) / 1e6; output: 500*15 / 1e6.
    expect(costUsd("claude-sonnet-4-6", 3000, 500, 1000, 1000)).toBeCloseTo(0.01455, 10);
    // opus-4-8: no uncached input, all cache read, plus output.
    expect(costUsd("claude-opus-4-8", 1000, 200, 0, 1000)).toBeCloseTo(0.0055, 10);
  });

  it("defensively clamps uncached input when cache details exceed total input", () => {
    expect(costUsd("claude-haiku-4-5", 100, 0, 90, 90)).toBeCloseTo(0.0001215, 10);
  });

  it("unknown model costs 0 and is flagged unpriced (never throws)", () => {
    expect(costUsd("some-future-model", 1000, 1000, 100, 100)).toBe(0);
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

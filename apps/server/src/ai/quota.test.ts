import { describe, expect, it } from "vitest";
import { checkQuota, dayStartUtc, monthStartUtc } from "./quota.js";

describe("ai quota windows", () => {
  it("dayStartUtc snaps to 00:00:00.000 UTC of the same day", () => {
    const noon = Date.UTC(2026, 5, 13, 12, 34, 56, 789); // 2026-06-13T12:34:56Z
    expect(dayStartUtc(noon)).toBe(Date.UTC(2026, 5, 13));
    // last ms of the day still maps to the same day start
    const lastMs = Date.UTC(2026, 5, 13, 23, 59, 59, 999);
    expect(dayStartUtc(lastMs)).toBe(Date.UTC(2026, 5, 13));
    // first ms of the next day maps to the next day start
    const nextDay = Date.UTC(2026, 5, 14, 0, 0, 0, 0);
    expect(dayStartUtc(nextDay)).toBe(Date.UTC(2026, 5, 14));
  });

  it("monthStartUtc snaps to the 1st at 00:00 UTC", () => {
    const mid = Date.UTC(2026, 5, 13, 12, 0, 0);
    expect(monthStartUtc(mid)).toBe(Date.UTC(2026, 5, 1));
    const lastMs = Date.UTC(2026, 5, 30, 23, 59, 59, 999);
    expect(monthStartUtc(lastMs)).toBe(Date.UTC(2026, 5, 1));
    const nextMonth = Date.UTC(2026, 6, 1, 0, 0, 0);
    expect(monthStartUtc(nextMonth)).toBe(Date.UTC(2026, 6, 1));
  });

  const limits = { userDailyUsd: 5, canvasMonthlyUsd: 50 };

  it("allows when both windows are under limit", () => {
    expect(checkQuota(4.99, 49.99, limits)).toEqual({ ok: true });
    expect(checkQuota(0, 0, limits)).toEqual({ ok: true });
  });

  it("rejects user_daily when prior user spend meets/exceeds the limit", () => {
    expect(checkQuota(5, 0, limits)).toEqual({ ok: false, scope: "user_daily" });
    expect(checkQuota(5.01, 0, limits)).toEqual({ ok: false, scope: "user_daily" });
  });

  it("rejects canvas_monthly when canvas spend meets/exceeds the limit", () => {
    expect(checkQuota(0, 50, limits)).toEqual({ ok: false, scope: "canvas_monthly" });
  });

  it("user_daily wins when both windows are exhausted", () => {
    expect(checkQuota(10, 100, limits)).toEqual({ ok: false, scope: "user_daily" });
  });
});

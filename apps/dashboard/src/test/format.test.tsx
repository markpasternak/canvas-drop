import { afterEach, describe, expect, it } from "vitest";
import { expiryLabel, formatBytes, relativeTime, toDatetimeLocal } from "../lib/format.js";

describe("formatBytes", () => {
  it("formats across unit boundaries", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  it("handles just-now, minutes, days", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
  });
});

describe("expiryLabel", () => {
  const now = 1_000_000_000_000;
  it("counts down and reports expired", () => {
    expect(expiryLabel(now - 1000, now)).toBe("expired");
    expect(expiryLabel(now + 2 * 86_400_000, now)).toBe("expires in 2d");
    expect(expiryLabel(now + 3 * 3_600_000, now)).toBe("expires in 3h");
  });
});

describe("toDatetimeLocal", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it("formats in LOCAL time, not UTC (datetime-local seeding bug)", () => {
    process.env.TZ = "America/New_York"; // UTC-4 in June (DST)
    // 2026-06-14T19:00:00Z is 15:00 local — the input must show 15:00, not 19:00.
    const epoch = Date.UTC(2026, 5, 14, 19, 0);
    expect(toDatetimeLocal(epoch)).toBe("2026-06-14T15:00");
  });

  it("zero-pads month, day, hour, and minute", () => {
    process.env.TZ = "UTC";
    expect(toDatetimeLocal(Date.UTC(2026, 0, 3, 4, 5))).toBe("2026-01-03T04:05");
  });
});

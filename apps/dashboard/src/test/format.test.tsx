import { describe, expect, it } from "vitest";
import { expiryLabel, formatBytes, relativeTime } from "../lib/format.js";

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

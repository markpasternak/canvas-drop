import { describe, expect, it } from "vitest";
import {
  canvasCacheControl,
  cdnAccessDowngradeWarning,
  effectiveEdgeTtlSec,
  humanizeDuration,
} from "./cdn-cache.js";

describe("effectiveEdgeTtlSec", () => {
  const now = 1_700_000_000_000;
  it("returns the configured TTL when there is no share expiry", () => {
    expect(effectiveEdgeTtlSec(300, null, now)).toBe(300);
  });
  it("clamps to the seconds left when the share expires within the TTL", () => {
    expect(effectiveEdgeTtlSec(300, now + 30_000, now)).toBe(30);
  });
  it("keeps the configured TTL when expiry is further out than the TTL", () => {
    expect(effectiveEdgeTtlSec(300, now + 3_600_000, now)).toBe(300);
  });
  it("never goes negative for an already-expired share", () => {
    expect(effectiveEdgeTtlSec(300, now - 5000, now)).toBe(0);
  });
});

describe("canvasCacheControl", () => {
  it("auth-gated content is private — never shared-cacheable", () => {
    expect(
      canvasCacheControl({ contentHashed: false, anonymouslyPublic: false, edgeTtlSec: 300 }),
    ).toBe("private, no-cache");
    expect(
      canvasCacheControl({ contentHashed: true, anonymouslyPublic: false, edgeTtlSec: 300 }),
    ).toBe("private, max-age=31536000, immutable");
  });

  it("public HTML is shared-cacheable for s-maxage but the browser still revalidates", () => {
    expect(
      canvasCacheControl({ contentHashed: false, anonymouslyPublic: true, edgeTtlSec: 300 }),
    ).toBe("public, max-age=0, s-maxage=300");
  });

  it("public hashed assets are public + immutable regardless of TTL", () => {
    expect(
      canvasCacheControl({ contentHashed: true, anonymouslyPublic: true, edgeTtlSec: 0 }),
    ).toBe("public, max-age=31536000, immutable");
  });

  it("TTL 0 disables shared caching of public HTML (public, no-cache)", () => {
    expect(
      canvasCacheControl({ contentHashed: false, anonymouslyPublic: true, edgeTtlSec: 0 }),
    ).toBe("public, no-cache");
  });
});

describe("humanizeDuration", () => {
  it("renders coarse, human units", () => {
    expect(humanizeDuration(1)).toBe("about a second");
    expect(humanizeDuration(45)).toBe("about 45 seconds");
    expect(humanizeDuration(60)).toBe("about a minute");
    expect(humanizeDuration(300)).toBe("about 5 minutes");
    expect(humanizeDuration(3600)).toBe("about an hour");
    expect(humanizeDuration(7200)).toBe("about 2 hours");
  });
});

describe("cdnAccessDowngradeWarning", () => {
  it("quotes the TTL in human terms when shared caching is enabled", () => {
    const w = cdnAccessDowngradeWarning(300);
    expect(w).toContain("about 5 minutes");
    expect(w).toMatch(/CDN/);
    expect(w).toContain("up to a year");
    expect(w).toContain("Purge");
  });

  it("warns about immutable assets even when HTML edge caching is off", () => {
    expect(cdnAccessDowngradeWarning(0)).toContain("up to a year");
    expect(cdnAccessDowngradeWarning(0)).not.toContain("HTML pages");
  });
});

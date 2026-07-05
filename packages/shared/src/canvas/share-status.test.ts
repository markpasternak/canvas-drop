import { describe, expect, it } from "vitest";
import { shareStatus } from "./share-status.js";

const NOW = 1_000_000;

describe("shareStatus", () => {
  it("live: a shareable rung, unexpired, not revoked", () => {
    expect(shareStatus("public_link", null, null, NOW)).toBe("live");
    expect(shareStatus("specific_people", NOW + 1000, null, NOW)).toBe("live");
  });

  it("private: the rung is private (owner-only), not revoked/expired", () => {
    expect(shareStatus("private", null, null, NOW)).toBe("private");
  });

  it("expired: share expiry has passed (and not revoked)", () => {
    expect(shareStatus("public_link", NOW - 1, null, NOW)).toBe("expired");
    // boundary: expiry exactly at now counts as expired (<=)
    expect(shareStatus("public_link", NOW, null, NOW)).toBe("expired");
  });

  it("revoked: revoked_at set wins over everything", () => {
    expect(shareStatus("public_link", null, NOW, NOW)).toBe("revoked");
    // revoked wins over expired
    expect(shareStatus("public_link", NOW - 1, NOW, NOW)).toBe("revoked");
    // revoked wins over private
    expect(shareStatus("private", null, NOW, NOW)).toBe("revoked");
  });

  it("precedence: expired outranks private (documented flat order)", () => {
    // a private rung with a past expiry resolves to expired per the flat precedence
    expect(shareStatus("private", NOW - 1, null, NOW)).toBe("expired");
  });
});

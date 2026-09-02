import { describe, expect, it } from "vitest";
import { type PublicationStatusInput, publicationStatusOf } from "./publication-status.js";

const NOW = 1_000_000;
const base: PublicationStatusInput = {
  status: "active",
  hasCurrentVersion: true,
  revokedAt: null,
  sharedExpiresAt: null,
  now: NOW,
};

describe("publicationStatusOf — the state matrix", () => {
  it("published: active, a served version, not revoked, no or future expiry", () => {
    expect(publicationStatusOf(base)).toBe("published");
    expect(publicationStatusOf({ ...base, sharedExpiresAt: NOW + 1 })).toBe("published");
  });

  it("expired: the share expiry has passed (boundary: exactly now counts)", () => {
    expect(publicationStatusOf({ ...base, sharedExpiresAt: NOW - 1 })).toBe("expired");
    expect(publicationStatusOf({ ...base, sharedExpiresAt: NOW })).toBe("expired");
  });

  it("draft: no version has been published — a past expiry does not make a draft expired", () => {
    expect(publicationStatusOf({ ...base, hasCurrentVersion: false })).toBe("draft");
    expect(
      publicationStatusOf({ ...base, hasCurrentVersion: false, sharedExpiresAt: NOW - 1 }),
    ).toBe("draft");
  });

  it("unpublished: revoked outranks the version and the expiry", () => {
    expect(publicationStatusOf({ ...base, revokedAt: NOW })).toBe("unpublished");
    expect(publicationStatusOf({ ...base, revokedAt: NOW, hasCurrentVersion: false })).toBe(
      "unpublished",
    );
    expect(publicationStatusOf({ ...base, revokedAt: NOW, sharedExpiresAt: NOW - 1 })).toBe(
      "unpublished",
    );
  });

  it("row lifecycle outranks share facts: archived, disabled, deleted", () => {
    for (const status of ["archived", "disabled", "deleted"] as const) {
      expect(publicationStatusOf({ ...base, status })).toBe(status);
      expect(publicationStatusOf({ ...base, status, revokedAt: NOW })).toBe(status);
      expect(publicationStatusOf({ ...base, status, hasCurrentVersion: false })).toBe(status);
      expect(publicationStatusOf({ ...base, status, sharedExpiresAt: NOW - 1 })).toBe(status);
    }
    expect(publicationStatusOf({ ...base, status: "disabled", revokedAt: NOW })).toBe("disabled");
  });

  it("is independent of the audience: the helper accepts no `access` input (compile-time pin)", () => {
    // Audience is `accessModeOf`'s concern. Adding `access` to the input type would make the
    // line below compile — and this test's typecheck fail — which is the whole point.
    expect(
      // @ts-expect-error audience is not an input to the lifecycle helper
      publicationStatusOf({ ...base, access: "public_link" }),
    ).toBe("published");
  });
});

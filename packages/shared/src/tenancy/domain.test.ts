import { describe, expect, it } from "vitest";
import { domainOfEmail, normalizeDomain, orgSlug, tryNormalizeDomain } from "./domain.js";

describe("normalizeDomain", () => {
  it("trims, lowercases, and strips a trailing FQDN dot", () => {
    expect(normalizeDomain("  Acme.COM  ")).toBe("acme.com");
    expect(normalizeDomain("acme.com.")).toBe("acme.com");
    expect(normalizeDomain("Eng.Acme.com")).toBe("eng.acme.com");
  });

  it("throws on non-ASCII, bare hostnames, and malformed input (fail-loud)", () => {
    expect(() => normalizeDomain("café.com")).toThrow(/invalid email domain/);
    expect(() => normalizeDomain("localhost")).toThrow(/invalid email domain/); // no dot
    expect(() => normalizeDomain("acme .com")).toThrow(/invalid email domain/);
    expect(() => normalizeDomain("")).toThrow(/invalid email domain/);
  });

  it("treats a subdomain as distinct from its parent (exact match, KTD2)", () => {
    expect(normalizeDomain("eng.acme.com")).not.toBe(normalizeDomain("acme.com"));
  });
});

describe("tryNormalizeDomain", () => {
  it("returns null on malformed input instead of throwing (runtime user-domain path)", () => {
    expect(tryNormalizeDomain("Acme.com")).toBe("acme.com");
    expect(tryNormalizeDomain("café.com")).toBeNull();
    expect(tryNormalizeDomain(null)).toBeNull();
    expect(tryNormalizeDomain(undefined)).toBeNull();
    expect(tryNormalizeDomain("")).toBeNull();
  });
});

describe("domainOfEmail", () => {
  it("extracts + normalizes the domain; null when there is no usable domain", () => {
    expect(domainOfEmail("User@Acme.com")).toBe("acme.com");
    expect(domainOfEmail("u@eng.acme.com")).toBe("eng.acme.com");
    expect(domainOfEmail("no-at-sign")).toBeNull();
    expect(domainOfEmail("u@café.com")).toBeNull(); // non-ASCII → no match (guest)
    expect(domainOfEmail(null)).toBeNull();
  });
});

describe("orgSlug", () => {
  it("produces a url-safe slug, falling back to 'org' for empty input", () => {
    expect(orgSlug("Acme Inc.")).toBe("acme-inc");
    expect(orgSlug("  Foo / Bar  ")).toBe("foo-bar");
    expect(orgSlug("!!!")).toBe("org");
  });

  it("collapses separator runs and trims leading/trailing ones", () => {
    expect(orgSlug("  --Hello, World!--  ")).toBe("hello-world");
    expect(orgSlug("a-b--c---d")).toBe("a-b-c-d");
    expect(orgSlug("UPPER_case_123")).toBe("upper-case-123");
  });

  it("handles pathological separator-heavy input in linear time (ReDoS-safe)", () => {
    // A long run of dashes used to risk polynomial backtracking in the trim regex
    // (CodeQL #8). The split-based form is linear — assert correctness + that it returns
    // promptly rather than hanging.
    const t0 = performance.now();
    expect(orgSlug(`${"-".repeat(100_000)}acme${"-".repeat(100_000)}`)).toBe("acme");
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

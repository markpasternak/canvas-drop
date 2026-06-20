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
});

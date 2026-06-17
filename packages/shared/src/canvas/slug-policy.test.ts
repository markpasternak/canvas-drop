import { describe, expect, it } from "vitest";
import { normalizeSlug, RESERVED_SLUGS, validateSlug } from "./slug-policy.js";

describe("normalizeSlug", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(normalizeSlug("My Prototype")).toBe("my-prototype");
  });

  it("collapses runs of invalid characters to a single hyphen", () => {
    expect(normalizeSlug("a  b__c!!d")).toBe("a-b-c-d");
  });

  it("trims leading and trailing hyphens and spaces", () => {
    expect(normalizeSlug("  -Hello-  ")).toBe("hello");
  });

  it("returns empty string when nothing valid remains", () => {
    expect(normalizeSlug("!!!")).toBe("");
    expect(normalizeSlug("🎨✨")).toBe("");
  });
});

describe("validateSlug", () => {
  it("accepts a normal custom slug", () => {
    expect(validateSlug("team-dashboard")).toEqual({ ok: true });
  });

  it("accepts the readable-random generator shape", () => {
    expect(validateSlug("quiet-otter-x7k2m9abcdef")).toEqual({ ok: true });
  });

  it.each([
    ["", "empty"],
    ["-lead", "leading hyphen"],
    ["trail-", "trailing hyphen"],
    ["UPPER", "uppercase"],
    ["a_b", "underscore"],
    ["a b", "space"],
    ["café", "non-ascii"],
    ["a".repeat(64), "64 chars (too long)"],
  ])("rejects %s as invalid (%s)", (slug) => {
    expect(validateSlug(slug)).toEqual({ ok: false, reason: "invalid" });
  });

  it("accepts boundary lengths 1 and 63", () => {
    expect(validateSlug("a")).toEqual({ ok: true });
    expect(validateSlug("a".repeat(63))).toEqual({ ok: true });
  });

  it("rejects every reserved word", () => {
    for (const word of RESERVED_SLUGS) {
      expect(validateSlug(word)).toEqual({ ok: false, reason: "reserved" });
    }
  });

  it("reserves the surfaces a custom slug could shadow in subdomain mode", () => {
    for (const word of ["mcp", "api", "docs", "gallery", "healthz", "welcome", "www"]) {
      expect(RESERVED_SLUGS.has(word)).toBe(true);
    }
  });
});

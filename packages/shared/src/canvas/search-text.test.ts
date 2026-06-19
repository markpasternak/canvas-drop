import { describe, expect, it } from "vitest";
import {
  computeSearchText,
  escapeLikeToken,
  normalize,
  searchTextPatterns,
} from "./search-text.js";

describe("normalize", () => {
  it("lowercases, strips accents, collapses whitespace, and trims", () => {
    expect(normalize("  Café   RÉSUMÉ  ")).toBe("cafe resume");
    expect(normalize("Ünïcödë")).toBe("unicode");
    expect(normalize("A\t\nB")).toBe("a b");
  });

  it("leaves LIKE metacharacters as literal characters", () => {
    expect(normalize("50%_OFF")).toBe("50%_off");
  });
});

describe("computeSearchText (pinned composition)", () => {
  it("joins title + description + tags(in order) + slug with single spaces", () => {
    expect(
      computeSearchText({
        title: "Quarterly Revenue",
        description: "Board forecast",
        tags: ["Finance", "Q3"],
        slug: "quarterly-revenue",
      }),
    ).toBe("quarterly revenue board forecast finance q3 quarterly-revenue");
  });

  it("treats a null/absent description as the empty string and absent tags as none", () => {
    expect(computeSearchText({ title: "A", description: null, tags: null, slug: "b" })).toBe("a b");
    expect(computeSearchText({ title: "A", slug: "b" })).toBe("a b");
  });

  it("ignores non-string tag entries defensively", () => {
    expect(
      computeSearchText({
        title: "T",
        // biome-ignore lint/suspicious/noExplicitAny: simulating a malformed stored tags array
        tags: ["ok", 5 as any, null as any],
        slug: "s",
      }),
    ).toBe("t ok s");
  });
});

describe("searchTextPatterns", () => {
  it("yields one escaped %token% per normalized whitespace-separated token", () => {
    expect(searchTextPatterns("Café Q3")).toEqual(["%cafe%", "%q3%"]);
  });

  it("escapes LIKE metacharacters within a token", () => {
    expect(searchTextPatterns("50%_off")).toEqual(["%50\\%\\_off%"]);
  });

  it("returns no patterns for an empty or whitespace-only query", () => {
    expect(searchTextPatterns("")).toEqual([]);
    expect(searchTextPatterns("   ")).toEqual([]);
  });
});

describe("escapeLikeToken", () => {
  it("escapes backslash, percent, and underscore", () => {
    expect(escapeLikeToken("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
  });
});

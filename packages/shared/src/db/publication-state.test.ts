import { describe, expect, it } from "vitest";
import { publicationState } from "./publication-state.js";

describe("publicationState", () => {
  it("disabled outranks a current version (AE1)", () => {
    expect(publicationState("disabled", true)).toBe("disabled");
    expect(publicationState("disabled", false)).toBe("disabled");
  });

  it("archived outranks published and draft", () => {
    expect(publicationState("archived", true)).toBe("archived");
    expect(publicationState("archived", false)).toBe("archived");
  });

  it("active with a current version is published", () => {
    expect(publicationState("active", true)).toBe("published");
  });

  it("active without a current version is draft (AE2)", () => {
    expect(publicationState("active", false)).toBe("draft");
  });

  it("treats deleted as archived defensively (never surfaced)", () => {
    expect(publicationState("deleted", true)).toBe("archived");
    expect(publicationState("deleted", false)).toBe("archived");
  });
});

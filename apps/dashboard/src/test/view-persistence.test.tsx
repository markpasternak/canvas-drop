import { afterEach, describe, expect, it, vi } from "vitest";
import { createViewPersistence } from "../lib/view-persistence.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("createViewPersistence", () => {
  it("round-trips a persisted layout choice through localStorage", () => {
    const vp = createViewPersistence("cd:test:view", "grid");
    // Unset → null, falls back to the surface default on resolve.
    expect(vp.readStored()).toBeNull();
    expect(vp.resolve(undefined)).toBe("grid");

    // Persist, then read it straight back.
    vp.persist("list");
    expect(vp.readStored()).toBe("list");
    // With no URL param, the stored choice wins over the default.
    expect(vp.resolve(undefined)).toBe("list");
    // A URL `?view=` param wins over both (deep-link precedence).
    expect(vp.resolve("grid")).toBe("grid");
  });

  it("ignores a junk stored value (not 'grid'/'list')", () => {
    const vp = createViewPersistence("cd:test:junk", "list");
    localStorage.setItem("cd:test:junk", "nonsense");
    // An unrecognized stored value reads as null and resolves to the default.
    expect(vp.readStored()).toBeNull();
    expect(vp.resolve(undefined)).toBe("list");
  });

  it("readStored() returns null when localStorage.getItem throws (guarded-unavailable branch)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("private mode / unavailable");
    });
    const vp = createViewPersistence("cd:test:throws", "grid");
    // The try/catch swallows the throw and falls back to null...
    expect(vp.readStored()).toBeNull();
    // ...so resolve still produces the surface default rather than propagating.
    expect(vp.resolve(undefined)).toBe("grid");
  });
});

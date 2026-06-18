import { describe, expect, it } from "vitest";
import { usePagination } from "../lib/use-pagination.js";

// usePagination is a pure derivation (no hooks/state), so we call it directly.
describe("usePagination", () => {
  it("reports from/to for a full first page", () => {
    expect(usePagination({ total: 25, offset: 0, itemCount: 10, page: 1 })).toEqual({
      from: 1,
      to: 10,
      hasPrev: false,
      hasNext: true,
    });
  });

  it("reports from/to for a middle page and gates both directions", () => {
    expect(usePagination({ total: 25, offset: 10, itemCount: 10, page: 2 })).toEqual({
      from: 11,
      to: 20,
      hasPrev: true,
      hasNext: true,
    });
  });

  it("has no next on the last page", () => {
    expect(usePagination({ total: 25, offset: 20, itemCount: 5, page: 3 })).toEqual({
      from: 21,
      to: 25,
      hasPrev: true,
      hasNext: false,
    });
  });

  it("reports from=0 for an empty result set", () => {
    expect(usePagination({ total: 0, offset: 0, itemCount: 0, page: 1 })).toEqual({
      from: 0,
      to: 0,
      hasPrev: false,
      hasNext: false,
    });
  });

  it("clamps `to` to total so a stale-data render can't show to > total", () => {
    // keepPreviousData: 10 stale items render while total has dropped to 5.
    const { to, hasNext } = usePagination({ total: 5, offset: 0, itemCount: 10, page: 1 });
    expect(to).toBe(5);
    expect(hasNext).toBe(false);
  });
});

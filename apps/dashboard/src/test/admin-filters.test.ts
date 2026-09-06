import { describe, expect, it } from "vitest";
import { adminCanvasConditions, normalizeAdminCanvasSearch } from "../lib/admin-filters.js";

describe("admin filter input", () => {
  it("preserves false across parsed and string URLs without treating invalid strings as true", () => {
    const search = normalizeAdminCanvasSearch({
      public: "true",
      password: "false",
      pending: false,
      external: "anything",
      page: "2",
      expiry: "not_expired",
    });
    expect(search).toMatchObject({
      public: true,
      password: false,
      pending: false,
      page: 2,
      expiry: "not_expired",
    });
    expect(search.external).toBeUndefined();
    expect(adminCanvasConditions(search).map((c) => c.label)).toEqual([
      "Effective public link: Yes",
      "Password: No",
      "Pending access: No",
      "Not expired",
    ]);
  });

  it("ignores malformed saved fields, unsafe pagination and arbitrary route keys", () => {
    const search = normalizeAdminCanvasSearch({
      q: { value: "oops" },
      owner: ["someone"],
      status: "oops",
      page: Infinity,
      redirect: "https://outside.test",
      password: [],
    });
    expect(adminCanvasConditions(search)).toEqual([]);
    expect(search.page).toBeUndefined();
    expect(search).not.toHaveProperty("redirect");
    expect(adminCanvasConditions(normalizeAdminCanvasSearch(null))).toEqual([]);
  });
});

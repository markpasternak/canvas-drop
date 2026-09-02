import { describe, expect, it } from "vitest";
import { accessModeOf } from "./access-mode.js";

describe("accessModeOf", () => {
  it("folds private and its legacy aliases into restricted", () => {
    expect(accessModeOf("private")).toBe("restricted");
    expect(accessModeOf("specific_people")).toBe("restricted");
    expect(accessModeOf("team")).toBe("restricted");
  });

  it("passes the two open values through", () => {
    expect(accessModeOf("whole_org")).toBe("whole_org");
    expect(accessModeOf("public_link")).toBe("public_link");
  });

  it("reads an unknown value as restricted (fail closed)", () => {
    expect(accessModeOf("something_new")).toBe("restricted");
    expect(accessModeOf("")).toBe("restricted");
  });
});

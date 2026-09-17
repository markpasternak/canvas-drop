import { describe, expect, it } from "vitest";
import { validatePublicPolicy } from "./public-policy.js";

describe("public connection policy", () => {
  const policy = { paths: ["/v1/analyze"], methods: ["POST"], requestsPerDay: 2000 };
  it("accepts a bounded exact endpoint or explicit disable", () => {
    expect(validatePublicPolicy(policy, ["POST"])).toEqual(policy);
    expect(validatePublicPolicy(null, ["POST"])).toBeNull();
  });
  it.each([
    "https://elsewhere.test/",
    "//elsewhere.test/",
    "/a?b=1",
    "/a#b",
    "/a/../b",
    "/a\\b",
    "/%61",
    "/a\nb",
    "",
  ])("rejects noncanonical path %j", (path) => {
    expect(() => validatePublicPolicy({ ...policy, paths: [path] }, ["POST"])).toThrow();
  });
  it.each([0, -1, 1.5, 1_000_001, "2000", null])("rejects invalid cap %j", (requestsPerDay) => {
    expect(() => validatePublicPolicy({ ...policy, requestsPerDay }, ["POST"])).toThrow();
  });
  it("rejects missing endpoints, extra fields and methods outside the profile", () => {
    for (const input of [
      undefined,
      {},
      { ...policy, paths: [] },
      { ...policy, methods: [] },
      { ...policy, extra: true },
    ]) {
      expect(() => validatePublicPolicy(input, ["POST"])).toThrow();
    }
    expect(() => validatePublicPolicy(policy, ["GET"])).toThrow();
  });
});

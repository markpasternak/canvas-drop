import { describe, expect, it } from "vitest";
import { resolveHomeOrg } from "./home-org.js";

describe("resolveHomeOrg (plan 002 U4)", () => {
  it("accepts a requested org the caller belongs to", () => {
    expect(resolveHomeOrg("org-A", new Set(["org-A"]))).toEqual({ orgId: "org-A" });
  });

  it("REJECTS a requested org outside the caller's membership (never trust the client)", () => {
    expect(resolveHomeOrg("org-EVIL", new Set(["org-A"]))).toEqual({ error: "org_forbidden" });
    expect(resolveHomeOrg("org-A", new Set())).toEqual({ error: "org_forbidden" }); // guest
  });

  it("accepts an explicit null/empty as personal", () => {
    expect(resolveHomeOrg(null, new Set(["org-A"]))).toEqual({ orgId: null });
    expect(resolveHomeOrg("", new Set(["org-A"]))).toEqual({ orgId: null });
  });

  it("defaults to the caller's org when they belong to exactly one (members default Org)", () => {
    expect(resolveHomeOrg(undefined, new Set(["org-A"]))).toEqual({ orgId: "org-A" });
  });

  it("defaults to personal for a guest (∅) — and for multi-org until P3 picks one", () => {
    expect(resolveHomeOrg(undefined, new Set())).toEqual({ orgId: null });
    expect(resolveHomeOrg(undefined, new Set(["a", "b"]))).toEqual({ orgId: null });
  });
});

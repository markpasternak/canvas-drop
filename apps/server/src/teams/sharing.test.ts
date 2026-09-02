import { describe, expect, it } from "vitest";
import { resolveTeamGrant } from "./sharing.js";

/** A teams store with the actor on the given teams; every team is org-homed unless `orgId` is null. */
function teams(actorTeams: string[] = ["t1", "t2"], orgId: string | null = "org-A") {
  return {
    findById: async (id: string) => ({
      id,
      orgId,
      name: id,
      slug: id,
      createdBy: "x",
      createdAt: 0,
    }),
    isTeamMember: async (teamId: string, _actorId: string) => actorTeams.includes(teamId),
  } as unknown as Parameters<typeof resolveTeamGrant>[0];
}

describe("resolveTeamGrant — rung-independent viewer-team grants (restricted access model)", () => {
  it("does nothing when teamIds was not sent, whatever the rung change", async () => {
    for (const targetAccess of [undefined, "private", "team", "whole_org", "public_link"]) {
      expect(await resolveTeamGrant(teams(), "me", { canvasOrgId: "org-A", targetAccess })).toEqual(
        { kind: "none" },
      );
    }
  });

  it("writes the deduplicated set at ANY rung, including no rung change", async () => {
    for (const targetAccess of [undefined, "private", "whole_org", "public_link", "team"]) {
      expect(
        await resolveTeamGrant(teams(), "me", {
          canvasOrgId: "org-A",
          targetAccess,
          teamIds: ["t1", "t2", "t1"],
        }),
      ).toEqual({ kind: "write", teamIds: ["t1", "t2"] });
    }
  });

  it("refuses an explicit empty set (TEAM_REQUIRED) — removals go through the people list", async () => {
    expect(await resolveTeamGrant(teams(), "me", { canvasOrgId: "org-A", teamIds: [] })).toEqual({
      kind: "error",
      code: "TEAM_REQUIRED",
    });
    expect(
      await resolveTeamGrant(teams(), "me", {
        canvasOrgId: "org-A",
        targetAccess: "team",
        teamIds: [],
      }),
    ).toEqual({ kind: "error", code: "TEAM_REQUIRED" });
  });

  it("legacy carve-out: `[]` together with a rung change OFF team is a no-op (the grants stay on the list)", async () => {
    for (const targetAccess of ["private", "whole_org", "public_link"]) {
      expect(
        await resolveTeamGrant(teams(), "me", { canvasOrgId: "org-A", targetAccess, teamIds: [] }),
      ).toEqual({ kind: "none" });
    }
  });

  it("refuses a team the actor is not on, or an org team from another org (TEAM_FORBIDDEN); a personal team fits any canvas", async () => {
    expect(
      await resolveTeamGrant(teams(["t1"]), "me", { canvasOrgId: "org-A", teamIds: ["t1", "t9"] }),
    ).toEqual({ kind: "error", code: "TEAM_FORBIDDEN" });
    expect(
      await resolveTeamGrant(teams(["t1"], "org-B"), "me", {
        canvasOrgId: "org-A",
        teamIds: ["t1"],
      }),
    ).toEqual({ kind: "error", code: "TEAM_FORBIDDEN" });
    expect(
      await resolveTeamGrant(teams(["t1"], null), "me", { canvasOrgId: "org-A", teamIds: ["t1"] }),
    ).toEqual({ kind: "write", teamIds: ["t1"] });
  });
});

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

const RUNGS = ["private", "specific_people", "team", "whole_org", "public_link"] as const;

describe("resolveTeamGrant — rung-independent viewer-team grants (restricted access model)", () => {
  it("does nothing when teamIds was not sent, whatever the current rung or rung change", async () => {
    for (const currentAccess of RUNGS) {
      for (const targetAccess of [undefined, ...RUNGS]) {
        expect(
          await resolveTeamGrant(teams(), "me", {
            canvasOrgId: "org-A",
            currentAccess,
            targetAccess,
          }),
        ).toEqual({ kind: "none" });
      }
    }
  });

  it("writes the deduplicated set at ANY rung, including no rung change", async () => {
    for (const currentAccess of RUNGS) {
      for (const targetAccess of [undefined, ...RUNGS]) {
        expect(
          await resolveTeamGrant(teams(), "me", {
            canvasOrgId: "org-A",
            currentAccess,
            targetAccess,
            teamIds: ["t1", "t2", "t1"],
          }),
        ).toEqual({ kind: "write", teamIds: ["t1", "t2"] });
      }
    }
  });

  it("refuses an explicit empty set (TEAM_REQUIRED) — removals go through the people list", async () => {
    for (const currentAccess of RUNGS) {
      // No rung change at all.
      expect(
        await resolveTeamGrant(teams(), "me", { canvasOrgId: "org-A", currentAccess, teamIds: [] }),
      ).toEqual({ kind: "error", code: "TEAM_REQUIRED" });
      // Moving TO (or staying on) the team value.
      expect(
        await resolveTeamGrant(teams(), "me", {
          canvasOrgId: "org-A",
          currentAccess,
          targetAccess: "team",
          teamIds: [],
        }),
      ).toEqual({ kind: "error", code: "TEAM_REQUIRED" });
    }
  });

  it("legacy carve-out: `[]` together with a rung change OFF the team value is a no-op (the grants stay on the list)", async () => {
    for (const targetAccess of ["private", "specific_people", "whole_org", "public_link"]) {
      expect(
        await resolveTeamGrant(teams(), "me", {
          canvasOrgId: "org-A",
          currentAccess: "team",
          targetAccess,
          teamIds: [],
        }),
      ).toEqual({ kind: "none" });
    }
  });

  it("the carve-out is keyed on the real transition: an echoed or unrelated `access` with `[]` is still refused (review #9)", async () => {
    // Echoed, unchanged value on a canvas that is not on the team rung.
    for (const access of ["private", "specific_people", "whole_org", "public_link"] as const) {
      expect(
        await resolveTeamGrant(teams(), "me", {
          canvasOrgId: "org-A",
          currentAccess: access,
          targetAccess: access,
          teamIds: [],
        }),
      ).toEqual({ kind: "error", code: "TEAM_REQUIRED" });
    }
    // A rung change between two non-team values.
    expect(
      await resolveTeamGrant(teams(), "me", {
        canvasOrgId: "org-A",
        currentAccess: "whole_org",
        targetAccess: "private",
        teamIds: [],
      }),
    ).toEqual({ kind: "error", code: "TEAM_REQUIRED" });
  });

  it("refuses a team the actor is not on, or an org team from another org (TEAM_FORBIDDEN); a personal team fits any canvas", async () => {
    expect(
      await resolveTeamGrant(teams(["t1"]), "me", {
        canvasOrgId: "org-A",
        currentAccess: "private",
        teamIds: ["t1", "t9"],
      }),
    ).toEqual({ kind: "error", code: "TEAM_FORBIDDEN" });
    expect(
      await resolveTeamGrant(teams(["t1"], "org-B"), "me", {
        canvasOrgId: "org-A",
        currentAccess: "private",
        teamIds: ["t1"],
      }),
    ).toEqual({ kind: "error", code: "TEAM_FORBIDDEN" });
    expect(
      await resolveTeamGrant(teams(["t1"], null), "me", {
        canvasOrgId: "org-A",
        currentAccess: "private",
        teamIds: ["t1"],
      }),
    ).toEqual({ kind: "write", teamIds: ["t1"] });
  });
});

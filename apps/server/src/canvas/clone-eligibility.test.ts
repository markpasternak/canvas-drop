import type { Canvas } from "@canvas-drop/shared/db";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../http/types.js";
import { type CloneEligibilityDeps, isCloneEligibleForMember } from "./clone-eligibility.js";

const source = {
  id: "canvas-1",
  ownerId: "owner",
  status: "active",
  currentVersionId: "version-1",
  passwordHash: null,
  sharedExpiresAt: null,
  galleryListed: false,
  galleryTemplatable: false,
} as Canvas;

function dependencies() {
  const deps = {
    canvases: {
      isEffectiveEditor: vi.fn().mockResolvedValue(false),
      findCloneableTemplate: vi.fn().mockResolvedValue(null),
      isPrincipalAllowed: vi.fn().mockResolvedValue(false),
    },
    teams: { teamMatch: vi.fn().mockResolvedValue(false) },
    tenancyActive: true,
  } satisfies CloneEligibilityDeps;
  return deps;
}

describe("isCloneEligibleForMember", () => {
  it.each<Principal>([
    {
      kind: "guest",
      id: "guest:invite-1",
      inviteId: "invite-1",
      canvasId: source.id,
      email: "legacy@example.com",
    },
    { kind: "anonymous" },
    { kind: "capture", canvasId: source.id, versionId: "version-1" },
  ])("rejects the non-member principal $kind before any grant lookup", async (principal) => {
    const deps = dependencies();

    await expect(isCloneEligibleForMember(source, principal, deps, Date.now())).resolves.toBe(
      false,
    );
    expect(deps.canvases.isEffectiveEditor).not.toHaveBeenCalled();
    expect(deps.canvases.findCloneableTemplate).not.toHaveBeenCalled();
    expect(deps.canvases.isPrincipalAllowed).not.toHaveBeenCalled();
    expect(deps.teams.teamMatch).not.toHaveBeenCalled();
  });

  it("checks a materialized user id, so an email-only pending invitation cannot grant cloning", async () => {
    const deps = dependencies();
    const principal: Principal = {
      kind: "member",
      id: "member-1",
      isAdmin: false,
      orgIds: new Set(["org-1"]),
    };

    await expect(isCloneEligibleForMember(source, principal, deps, Date.now())).resolves.toBe(
      false,
    );
    expect(deps.canvases.isPrincipalAllowed).toHaveBeenCalledWith(source.id, {
      userId: principal.id,
    });
    expect(deps.teams.teamMatch).toHaveBeenCalledWith(source.id, principal.id, principal.orgIds);
  });
});

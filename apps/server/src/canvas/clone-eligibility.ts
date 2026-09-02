import type { Canvas } from "@canvas-drop/shared/db";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { Principal } from "../http/types.js";
import { isCloneableByViewerGrant } from "./clone-service.js";
import { resolveManagementGrant } from "./role.js";

export interface CloneEligibilityDeps {
  canvases: Pick<
    CanvasesRepository,
    "findCloneableTemplate" | "isEffectiveEditor" | "isPrincipalAllowed"
  >;
  teams?: Pick<TeamsRepository, "teamMatch">;
  tenancyActive: boolean;
}

/**
 * One clone-eligibility resolver for the dashboard and MCP surfaces.
 *
 * Managers keep their existing ability to clone any active canvas they manage.
 * Other signed-in members may clone an org-visible gallery template or a canvas
 * they can open through a direct/team viewer grant, provided the source passes
 * the published, active, unexpired, password-free viewer fences. Non-member
 * principals never enter the viewer-grant branches, and every refusal stays
 * opaque at the calling surface.
 */
export async function isCloneEligibleForMember(
  source: Canvas,
  principal: Principal,
  deps: CloneEligibilityDeps,
  now: number,
): Promise<boolean> {
  if (principal.kind !== "member" || source.status === "deleted") return false;

  const roleDeps = { canvases: deps.canvases, tenancyActive: deps.tenancyActive };
  if ((await resolveManagementGrant(source, principal, roleDeps)) !== null) {
    return source.status === "active";
  }

  const template = await deps.canvases.findCloneableTemplate(source.id, now, {
    tenancyActive: deps.tenancyActive,
    viewerOrgIds: principal.orgIds,
  });
  if (template !== null) return true;

  if (!isCloneableByViewerGrant(source, now)) return false;
  if (await deps.canvases.isPrincipalAllowed(source.id, { userId: principal.id })) return true;

  return (
    deps.teams !== undefined &&
    (await deps.teams.teamMatch(source.id, principal.id, principal.orgIds))
  );
}

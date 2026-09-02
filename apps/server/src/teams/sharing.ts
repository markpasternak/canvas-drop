import type { Team } from "@canvas-drop/shared/db";
import type { TeamsRepository } from "../db/repositories/teams.js";

/**
 * KTD4's per-team grant rule, shared by the settings flow ({@link resolveTeamGrant}) and
 * the people-list add-team path (editor-roles plan U5): the actor must be a LIVE member
 * of the team; an ORG team must match the canvas's org; a PERSONAL team (org_id null) is
 * grantable to any canvas. Returns the team when grantable, else null.
 */
export async function canGrantTeam(
  teams: Pick<TeamsRepository, "findById" | "isTeamMember">,
  actorId: string,
  canvasOrgId: string | null,
  teamId: string,
): Promise<Team | null> {
  const team = await teams.findById(teamId);
  if (!team) return null;
  if (team.orgId !== null && team.orgId !== canvasOrgId) return null;
  if (!(await teams.isTeamMember(teamId, actorId))) return null;
  return team;
}

/**
 * Shared team-sharing logic (plan 003). The HTTP management routes AND the MCP tools
 * wrap THESE functions — never a parallel copy — so the canvas→team grant rules and
 * visible-team list can't drift between surfaces (the agent-native parity rule).
 */

/** The canvas→team grant action resolved from a settings update. */
export type TeamGrantAction =
  | { kind: "write"; teamIds: string[] }
  | { kind: "none" }
  | { kind: "error"; code: "TEAM_REQUIRED" | "TEAM_FORBIDDEN" };

/**
 * Resolve what to do with a canvas's VIEWER-role team grants for a settings change.
 * Team grants live on the people-and-teams list and apply at EVERY rung (restricted access
 * model), so a rung change — to or from the legacy `team` alias, to whole_org, anywhere —
 * never touches them. The legacy `teamIds` field keeps its replace semantics for existing
 * agents: when sent, it becomes the exact set of viewer-role team grants (editor teams are
 * the list's alone, KTD4), each validated by the shared per-team rule ({@link canGrantTeam}:
 * a live member of that team; an org team in the canvas's org). An explicit empty set is
 * refused (`TEAM_REQUIRED`) rather than silently wiping grants — removals go through the
 * people-list revoke path — with one compatibility carve-out: the legacy "leave the Team
 * rung" shape (`teamIds: []` sent by a client that sees the canvas on the legacy `team`
 * value, together with an `access` change to anything but `team`) used to clear the grants
 * and is now a no-op, because the grants belong to the list. The carve-out is keyed on that
 * exact transition — current value `team`, new value not `team` — so an empty array with an
 * echoed or unrelated `access` value stays refused (review #9). Returns `none` when
 * `teamIds` wasn't sent.
 */
export async function resolveTeamGrant(
  teams: Pick<TeamsRepository, "findById" | "isTeamMember">,
  actorId: string,
  input: {
    canvasOrgId: string | null;
    /** The canvas's CURRENT persisted `access` value. */
    currentAccess: string;
    /** The resolved NEW rung when the same call changes `access`, else undefined. */
    targetAccess?: string;
    /** The provided team set, or undefined when `teamIds` wasn't sent. */
    teamIds?: string[];
  },
): Promise<TeamGrantAction> {
  if (input.teamIds === undefined) return { kind: "none" };
  const teamIds = [...new Set(input.teamIds)];
  if (teamIds.length === 0) {
    const leavingTeamRung =
      input.currentAccess === "team" &&
      input.targetAccess !== undefined &&
      input.targetAccess !== "team";
    return leavingTeamRung ? { kind: "none" } : { kind: "error", code: "TEAM_REQUIRED" };
  }
  for (const teamId of teamIds) {
    // Only the teams IN THE REQUEST are checked: grants the actor did not touch (another
    // member's editor team, say) are never re-validated (KTD4).
    if (!(await canGrantTeam(teams, actorId, input.canvasOrgId, teamId)))
      return { kind: "error", code: "TEAM_FORBIDDEN" };
  }
  return { kind: "write", teamIds };
}

/** One team visible to the viewer with their membership + management flags. `orgId` is null
 *  for a PERSONAL team (plan 003). */
export interface VisibleTeam {
  id: string;
  orgId: string | null;
  name: string;
  slug: string;
  /** The viewer is a member. */
  mine: boolean;
  /** The viewer may rename/delete it (creator, or an operator when `isAdmin`). */
  canManage: boolean;
}

/**
 * The teams visible to the viewer across their org(s), each flagged `mine`/`canManage`.
 * `isAdmin` lets the HTTP route grant operators manage any team; the MCP surface passes
 * `false` (admin cross-owner team actions live on the admin routes, not the per-account
 * MCP surface — the parity rule's documented exception).
 */
export async function resolveVisibleTeams(
  teams: Pick<TeamsRepository, "listForUser" | "listByOrg">,
  actorId: string,
  orgIds: Set<string>,
  isAdmin: boolean,
): Promise<VisibleTeam[]> {
  const myTeams = await teams.listForUser(actorId);
  const mine = new Set(myTeams.map((t) => t.id));
  const seen = new Set<string>();
  const out: VisibleTeam[] = [];
  const push = (t: (typeof myTeams)[number]) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push({
      id: t.id,
      orgId: t.orgId,
      name: t.name,
      slug: t.slug,
      mine: mine.has(t.id),
      canManage: isAdmin || t.createdBy === actorId,
    });
  };
  // The viewer's OWN teams first — this is the ONLY source of personal teams (org_id null),
  // which no `listByOrg` returns.
  for (const t of myTeams) push(t);
  // Plus the org teams of the viewer's org(s), visible to all members of that org.
  for (const orgId of orgIds) for (const t of await teams.listByOrg(orgId)) push(t);
  return out;
}

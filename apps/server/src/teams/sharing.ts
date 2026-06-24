import type { TeamsRepository } from "../db/repositories/teams.js";

/**
 * Shared team-sharing logic (plan 003). The HTTP management routes AND the MCP tools
 * wrap THESE functions — never a parallel copy — so the canvas→team grant rules and
 * visible-team list can't drift between surfaces (the agent-native parity rule).
 */

/** The canvas→team grant action resolved from a settings update. */
export type TeamGrantAction =
  | { kind: "write"; teamIds: string[] }
  | { kind: "clear" }
  | { kind: "none" }
  | { kind: "error"; code: "TEAM_REQUIRED" | "TEAM_FORBIDDEN" };

/**
 * Resolve what to do with a canvas's team grants for a settings change, validating that
 * the owner may grant each team (KTD4: a live member of that team, in the canvas's org).
 * Covers three shapes a caller can request:
 *  - **set the team rung** (`targetAccess === 'team'`): require ≥1 valid team.
 *  - **change the grant set with the rung unchanged** (`teamIds` sent, canvas already
 *    `team`): require ≥1 valid team — so an agent can re-pick teams without re-sending
 *    `access` (the dashboard always sends both; the MCP exposes `teamIds` independently).
 *  - **leave the team rung** (`targetAccess` set to anything else): clear the grants.
 * Returns `none` when nothing about the grants changes.
 */
export async function resolveTeamGrant(
  teams: Pick<TeamsRepository, "findById" | "isTeamMember">,
  actorId: string,
  input: {
    canvasOrgId: string | null;
    /** The canvas's current access rung. */
    currentAccess: string;
    /** The resolved NEW rung, or undefined when the rung isn't changing. */
    targetAccess?: string;
    /** The provided team set, or undefined when `teamIds` wasn't sent. */
    teamIds?: string[];
  },
): Promise<TeamGrantAction> {
  const settingTeam = input.targetAccess === "team";
  // A grant-set change with the rung unchanged: only when the canvas is ALREADY team-
  // scoped and the caller actually sent teamIds (else leave the grants untouched).
  const updatingGrants =
    input.targetAccess === undefined &&
    input.teamIds !== undefined &&
    input.currentAccess === "team";

  if (settingTeam || updatingGrants) {
    const teamIds = [...new Set(input.teamIds ?? [])];
    if (teamIds.length === 0) return { kind: "error", code: "TEAM_REQUIRED" };
    for (const teamId of teamIds) {
      const team = await teams.findById(teamId);
      // Owner must belong to the team; an ORG team must match the canvas's org; a PERSONAL
      // team (org_id null, plan 003) is grantable to any canvas the owner owns, incl. a
      // personal canvas (org_id null) — so only org-attached teams carry the org-match rule.
      if (
        !team ||
        (team.orgId !== null && team.orgId !== input.canvasOrgId) ||
        !(await teams.isTeamMember(teamId, actorId))
      )
        return { kind: "error", code: "TEAM_FORBIDDEN" };
    }
    return { kind: "write", teamIds };
  }
  // Rung changing away from team → the grants are meaningless; clear them.
  if (input.targetAccess !== undefined && input.targetAccess !== "team") return { kind: "clear" };
  return { kind: "none" };
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

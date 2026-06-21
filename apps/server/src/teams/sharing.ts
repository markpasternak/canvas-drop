import type { Canvas } from "@canvas-drop/shared/db";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";

/**
 * Shared team-sharing logic (plan 003). The HTTP management routes AND the MCP tools
 * wrap THESE functions — never a parallel copy — so the canvas→team grant rules, the
 * "shared with my teams" read, and the visible-team list can't drift between surfaces
 * (the agent-native parity rule; an earlier hand-copied MCP projection had already
 * dropped fields the HTTP route returned). Each caller adds its own presentation on top
 * (preview hints, URL, avatar) but the data + authz live here once.
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
      if (!team || team.orgId !== input.canvasOrgId || !(await teams.isTeamMember(teamId, actorId)))
        return { kind: "error", code: "TEAM_FORBIDDEN" };
    }
    return { kind: "write", teamIds };
  }
  // Rung changing away from team → the grants are meaningless; clear them.
  if (input.targetAccess !== undefined && input.targetAccess !== "team") return { kind: "clear" };
  return { kind: "none" };
}

/** One canvas shared with the viewer via a team — the raw canvas + a display-only owner
 *  projection (never the owner email or any secret). Callers add `url` + `hasPreview`. */
export interface SharedTeamCanvas {
  canvas: Canvas;
  owner: { id: string; name: string; avatarUrl: string | null } | null;
}

/**
 * The "shared with my teams" read: the live team canvases the viewer reaches via a team
 * they belong to (the KTD3 live-org re-join is in `listCanvasIdsForUserTeams`). Excludes
 * the viewer's OWN canvases (those live in Your-canvases) and anything not live
 * (unpublished/archived/disabled → unreachable anyway). Strictly team-scoped: these never
 * appear in the org-wide gallery, so this is their only enumeration surface.
 */
export async function listSharedWithTeams(
  deps: {
    teams: Pick<TeamsRepository, "listCanvasIdsForUserTeams">;
    canvases: Pick<CanvasesRepository, "findByIds">;
    users: Pick<UsersRepository, "findByIds">;
  },
  userId: string,
  orgIds: Set<string>,
): Promise<SharedTeamCanvas[]> {
  const ids = await deps.teams.listCanvasIdsForUserTeams(userId, orgIds);
  if (ids.length === 0) return [];
  const rows = (await deps.canvases.findByIds(ids)).filter(
    (cv) =>
      cv.ownerId !== userId &&
      cv.access === "team" &&
      cv.status === "active" &&
      cv.currentVersionId !== null,
  );
  const owners = new Map(
    (await deps.users.findByIds(rows.map((r) => r.ownerId))).map((u) => [u.id, u]),
  );
  return rows.map((cv) => {
    const u = owners.get(cv.ownerId);
    return {
      canvas: cv,
      owner: u ? { id: u.id, name: u.name, avatarUrl: u.avatarUrl ?? null } : null,
    };
  });
}

/** One team in the viewer's org(s) with their membership + management flags. */
export interface VisibleTeam {
  id: string;
  orgId: string;
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
  const mine = new Set((await teams.listForUser(actorId)).map((t) => t.id));
  const seen = new Set<string>();
  const out: VisibleTeam[] = [];
  for (const orgId of orgIds) {
    for (const t of await teams.listByOrg(orgId)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({
        id: t.id,
        orgId: t.orgId,
        name: t.name,
        slug: t.slug,
        mine: mine.has(t.id),
        canManage: isAdmin || t.createdBy === actorId,
      });
    }
  }
  return out;
}

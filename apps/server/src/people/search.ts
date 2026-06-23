import type { Config } from "@canvas-drop/shared";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { OrgMembersRepository } from "../db/repositories/org-members.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UserSearchResult, UsersRepository } from "../db/repositories/users.js";

export interface PeopleSearchDeps {
  config: Config;
  canvases: Pick<CanvasesRepository, "findById" | "listAllowlist">;
  teams: Pick<TeamsRepository, "findById" | "isTeamMember" | "getMembers">;
  users: Pick<UsersRepository, "search">;
  orgMembers: Pick<OrgMembersRepository, "searchMembers">;
}

export interface PeopleSearchActor {
  id: string;
  isAdmin: boolean;
  orgIds: Set<string>;
}

export type PeopleSearchInput =
  | { context: "canvas"; canvasId: string; q: string }
  | { context: "team"; teamId: string; q: string };

export type PeopleSearchResult =
  | { ok: true; people: UserSearchResult[] }
  | { ok: false; error: "not_found" };

function filterSuggestions(rows: UserSearchResult[], excludedIds: Set<string>): UserSearchResult[] {
  const seen = new Set<string>();
  const out: UserSearchResult[] = [];
  for (const row of rows) {
    if (excludedIds.has(row.id) || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

export async function searchPersonSuggestions(
  deps: PeopleSearchDeps,
  actor: PeopleSearchActor,
  input: PeopleSearchInput,
): Promise<PeopleSearchResult> {
  const excluded = new Set([actor.id]);

  if (input.context === "canvas") {
    const canvas = await deps.canvases.findById(input.canvasId);
    if (!canvas || canvas.ownerId !== actor.id) return { ok: false, error: "not_found" };
    for (const entry of await deps.canvases.listAllowlist(canvas.id)) {
      if (entry.userId) excluded.add(entry.userId);
    }
    const rows =
      canvas.orgId !== null
        ? actor.orgIds.has(canvas.orgId)
          ? await deps.orgMembers.searchMembers(canvas.orgId, input.q)
          : []
        : deps.config.org.name
          ? []
          : await deps.users.search(input.q);
    return { ok: true, people: filterSuggestions(rows, excluded) };
  }

  const team = await deps.teams.findById(input.teamId);
  if (!team) return { ok: false, error: "not_found" };
  const visible =
    actor.isAdmin ||
    (team.orgId !== null
      ? actor.orgIds.has(team.orgId)
      : team.createdBy === actor.id || (await deps.teams.isTeamMember(team.id, actor.id)));
  if (!visible) return { ok: false, error: "not_found" };
  for (const member of await deps.teams.getMembers(team.id)) excluded.add(member.userId);
  const rows = team.orgId === null ? [] : await deps.orgMembers.searchMembers(team.orgId, input.q);
  return { ok: true, people: filterSuggestions(rows, excluded) };
}

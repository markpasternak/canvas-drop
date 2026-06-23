import type { Config } from "@canvas-drop/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { OrgMembersRepository } from "../db/repositories/org-members.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UserSearchResult, UsersRepository } from "../db/repositories/users.js";
import type { AppEnv } from "../http/types.js";

export interface PeopleRoutesDeps {
  config: Config;
  canvases: Pick<CanvasesRepository, "findById" | "listAllowlist">;
  teams: Pick<TeamsRepository, "findById" | "isTeamMember" | "getMembers">;
  users: Pick<UsersRepository, "search">;
  orgMembers: Pick<OrgMembersRepository, "searchMembers">;
}

const searchSchema = z
  .object({
    context: z.enum(["canvas", "team"]),
    canvasId: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
    q: z.string().trim().min(1).max(80),
  })
  .superRefine((v, ctx) => {
    if (v.context === "canvas" && !v.canvasId) {
      ctx.addIssue({ code: "custom", path: ["canvasId"], message: "required" });
    }
    if (v.context === "team" && !v.teamId) {
      ctx.addIssue({ code: "custom", path: ["teamId"], message: "required" });
    }
  });

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

export function peopleRoutes(deps: PeopleRoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/search", async (c) => {
    const parsed = searchSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const actor = c.get("user");
    const actorOrgIds = c.get("orgIds") ?? new Set<string>();
    const excluded = new Set([actor.id]);

    if (parsed.data.context === "canvas") {
      const canvas = await deps.canvases.findById(parsed.data.canvasId as string);
      if (!canvas || canvas.ownerId !== actor.id) return c.json({ error: "not_found" }, 404);
      for (const entry of await deps.canvases.listAllowlist(canvas.id)) {
        if (entry.userId) excluded.add(entry.userId);
      }
      const rows =
        canvas.orgId !== null
          ? actorOrgIds.has(canvas.orgId)
            ? await deps.orgMembers.searchMembers(canvas.orgId, parsed.data.q)
            : []
          : deps.config.org.name
            ? []
            : await deps.users.search(parsed.data.q);
      return c.json({ people: filterSuggestions(rows, excluded) });
    }

    const team = await deps.teams.findById(parsed.data.teamId as string);
    if (!team) return c.json({ error: "not_found" }, 404);
    const visible =
      actor.isAdmin ||
      (team.orgId !== null
        ? actorOrgIds.has(team.orgId)
        : team.createdBy === actor.id || (await deps.teams.isTeamMember(team.id, actor.id)));
    if (!visible) return c.json({ error: "not_found" }, 404);
    for (const member of await deps.teams.getMembers(team.id)) excluded.add(member.userId);
    const rows =
      team.orgId === null ? [] : await deps.orgMembers.searchMembers(team.orgId, parsed.data.q);
    return c.json({ people: filterSuggestions(rows, excluded) });
  });

  return app;
}

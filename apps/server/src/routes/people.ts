import type { Config } from "@canvas-drop/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { OrgMembersRepository } from "../db/repositories/org-members.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { AppEnv } from "../http/types.js";
import { searchPersonSuggestions } from "../people/search.js";

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

export function peopleRoutes(deps: PeopleRoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/search", async (c) => {
    const parsed = searchSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const actor = c.get("user");
    const actorOrgIds = c.get("orgIds") ?? new Set<string>();
    const result = await searchPersonSuggestions(
      deps,
      { id: actor.id, isAdmin: actor.isAdmin, orgIds: actorOrgIds },
      parsed.data.context === "canvas"
        ? { context: "canvas", canvasId: parsed.data.canvasId as string, q: parsed.data.q }
        : { context: "team", teamId: parsed.data.teamId as string, q: parsed.data.q },
    );
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json({ people: result.people });
  });

  return app;
}

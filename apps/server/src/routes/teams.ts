import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { AppEnv } from "../http/types.js";
import type { TeamActor, TeamError, TeamsService } from "../teams/service.js";

/**
 * Team management API (plan 003 P2 / U3). Session-authenticated; the acting principal +
 * its LIVE `orgIds` come from the gateway context (never client input). All writes wrap
 * {@link TeamsService} — the same layer the MCP tools use (agent-native parity).
 */
export interface TeamsRoutesDeps {
  service: TeamsService;
  teams: Pick<
    TeamsRepository,
    "listByOrg" | "findById" | "listForUser" | "getMembers" | "isTeamMember"
  >;
  users: Pick<UsersRepository, "findByIds">;
}

const HTTP: Record<TeamError, 403 | 404 | 409> = {
  NOT_A_MEMBER: 403,
  TEAM_NOT_FOUND: 404,
  FORBIDDEN: 403,
  TARGET_NOT_FOUND: 404,
  TARGET_NOT_MEMBER: 409,
};

const createSchema = z.object({ orgId: z.string().min(1), name: z.string().trim().min(1).max(80) });
const renameSchema = z.object({ name: z.string().trim().min(1).max(80) });
const addMemberSchema = z.object({ email: z.string().trim().toLowerCase().email() });

export function teamsRoutes(deps: TeamsRoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const actorOf = (c: Context<AppEnv>): TeamActor => {
    const user = c.get("user");
    return { id: user.id, isAdmin: user.isAdmin, orgIds: c.get("orgIds") ?? new Set<string>() };
  };

  // List teams across the caller's org(s), flagging which they're a member of.
  app.get("/", async (c) => {
    const actor = actorOf(c);
    const seen = new Set<string>();
    const out: Array<{ id: string; orgId: string; name: string; slug: string; mine: boolean }> = [];
    const mine = new Set((await deps.teams.listForUser(actor.id)).map((t) => t.id));
    for (const orgId of actor.orgIds) {
      for (const t of await deps.teams.listByOrg(orgId)) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push({ id: t.id, orgId: t.orgId, name: t.name, slug: t.slug, mine: mine.has(t.id) });
      }
    }
    return c.json({ teams: out });
  });

  app.post("/", async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const r = await deps.service.create(actorOf(c), body.data);
    if (!r.ok) return c.json({ error: r.error }, HTTP[r.error]);
    return c.json(
      { team: { id: r.team.id, name: r.team.name, slug: r.team.slug, orgId: r.team.orgId } },
      201,
    );
  });

  app.patch("/:id", async (c) => {
    const body = renameSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const r = await deps.service.rename(actorOf(c), c.req.param("id"), body.data.name);
    if (!r.ok) return c.json({ error: r.error }, HTTP[r.error]);
    return c.json({ team: { id: r.team.id, name: r.team.name } });
  });

  app.delete("/:id", async (c) => {
    const r = await deps.service.remove(actorOf(c), c.req.param("id"));
    if (!r.ok) return c.json({ error: r.error }, HTTP[r.error]);
    return c.json({ ok: true });
  });

  // Roster — gated to a team in one of the caller's orgs (opaque 404 otherwise).
  app.get("/:id/members", async (c) => {
    const actor = actorOf(c);
    const team = await deps.teams.findById(c.req.param("id"));
    if (!team || !actor.orgIds.has(team.orgId)) return c.json({ error: "not_found" }, 404);
    const rows = await deps.teams.getMembers(team.id);
    const users = await deps.users.findByIds(rows.map((m) => m.userId));
    const byId = new Map(users.map((u) => [u.id, u]));
    return c.json({
      members: rows.map((m) => {
        const u = byId.get(m.userId);
        return { userId: m.userId, email: u?.email ?? null, name: u?.name ?? null };
      }),
    });
  });

  app.post("/:id/members", async (c) => {
    const body = addMemberSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const r = await deps.service.addMemberByEmail(actorOf(c), c.req.param("id"), body.data.email);
    if (!r.ok) return c.json({ error: r.error }, HTTP[r.error]);
    return c.json({ ok: true });
  });

  app.delete("/:id/members/:userId", async (c) => {
    const r = await deps.service.removeMember(actorOf(c), c.req.param("id"), c.req.param("userId"));
    if (!r.ok) return c.json({ error: r.error }, HTTP[r.error]);
    return c.json({ ok: true });
  });

  return app;
}

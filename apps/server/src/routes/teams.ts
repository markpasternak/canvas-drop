import type { Config } from "@canvas-drop/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";
import { requireSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
import type { TeamActor, TeamError, TeamsService } from "../teams/service.js";
import { resolveVisibleTeams } from "../teams/sharing.js";

/**
 * Team management API (plan 003 P2 / U3). Session-authenticated; the acting principal +
 * its LIVE `orgIds` come from the gateway context (never client input). All writes wrap
 * {@link TeamsService} — the same layer the MCP tools use (agent-native parity).
 */
export interface TeamsRoutesDeps {
  config: Config;
  service: TeamsService;
  teams: Pick<
    TeamsRepository,
    "listByOrg" | "findById" | "listForUser" | "getMembers" | "isTeamMember"
  >;
  users: Pick<UsersRepository, "findByIds">;
  /** Un-consumed invitations for a team's pending roster rows (plan 003 U6). */
  invitations: Pick<InvitationsRepository, "listPendingForTarget">;
}

const HTTP: Record<TeamError, 403 | 404 | 409 | 429> = {
  NOT_A_MEMBER: 403,
  TEAM_NOT_FOUND: 404,
  TEAM_NAME_TAKEN: 409,
  FORBIDDEN: 403,
  TARGET_NOT_FOUND: 404,
  TARGET_NOT_MEMBER: 409,
  TARGET_NOT_PERMITTED: 403,
  TARGET_BLOCKED: 403,
  AUTH_ADMISSION_REQUIRED: 403,
  RATE_LIMITED: 429,
};

// Personal teams (plan 003 U6) carry no org → `orgId` is optional/null; an org-attached team
// supplies a non-empty id the service re-checks against the actor's LIVE membership.
const createSchema = z.object({
  orgId: z.string().min(1).nullish(),
  name: z.string().trim().min(1).max(80),
});
const renameSchema = z.object({ name: z.string().trim().min(1).max(80) });
const addMemberSchema = z.object({ email: z.string().trim().toLowerCase().email() });

export function teamsRoutes(deps: TeamsRoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Same-origin guard on every mutation — parity with the admin/management routes. A
  // personal-team add now sends courtesy emails + records allowlist/pending rows, so a CSRF
  // slipping past SameSite=Lax would be an email-spam / allowlist-widening vector.
  const sameOrigin = requireSameOrigin(deps.config);

  const actorOf = (c: Context<AppEnv>): TeamActor => {
    const user = c.get("user");
    return {
      id: user.id,
      isAdmin: user.isAdmin,
      orgIds: c.get("orgIds") ?? new Set<string>(),
      name: user.name,
      email: user.email,
    };
  };

  // List teams across the caller's org(s), flagging which they're a member of (`mine`)
  // and which they may manage (rename/delete — creator or instance operator, KTD5).
  // `canManage` is a UX hint only; the service re-checks it on every mutation. Wraps the
  // shared resolver so the MCP `list_teams` tool can't drift from this shape.
  app.get("/", async (c) => {
    const actor = actorOf(c);
    const teams = await resolveVisibleTeams(deps.teams, actor.id, actor.orgIds, actor.isAdmin);
    return c.json({ teams });
  });

  app.post("/", sameOrigin, async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const r = await deps.service.create(actorOf(c), body.data);
    if (!r.ok) return c.json({ error: r.error }, HTTP[r.error]);
    // The creator is always a member AND its manager — return the full Team shape (mine +
    // canManage) so the response matches the list shape the client's Team type expects.
    return c.json(
      {
        team: {
          id: r.team.id,
          name: r.team.name,
          slug: r.team.slug,
          orgId: r.team.orgId,
          mine: true,
          canManage: true,
        },
      },
      201,
    );
  });

  app.patch("/:id", sameOrigin, async (c) => {
    const body = renameSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const r = await deps.service.rename(actorOf(c), c.req.param("id"), body.data.name);
    if (!r.ok) return c.json({ error: r.error }, HTTP[r.error]);
    return c.json({ team: { id: r.team.id, name: r.team.name } });
  });

  app.delete("/:id", sameOrigin, async (c) => {
    const r = await deps.service.remove(actorOf(c), c.req.param("id"));
    if (!r.ok) return c.json({ error: r.error }, HTTP[r.error]);
    return c.json({ ok: true });
  });

  // Roster — opaque 404 unless the caller may see the team. An ORG team's roster is visible
  // to any member of its org; a PERSONAL team's (org_id null, plan 003) to its creator + its
  // members. Cross-org/foreign personal teams read as not-found (no existence leak).
  app.get("/:id/members", async (c) => {
    const actor = actorOf(c);
    const team = await deps.teams.findById(c.req.param("id"));
    if (!team) return c.json({ error: "not_found" }, 404);
    const canSee =
      actor.isAdmin ||
      (team.orgId !== null
        ? actor.orgIds.has(team.orgId)
        : team.createdBy === actor.id || (await deps.teams.isTeamMember(team.id, actor.id)));
    if (!canSee) return c.json({ error: "not_found" }, 404);
    const rows = await deps.teams.getMembers(team.id);
    const users = await deps.users.findByIds(rows.map((m) => m.userId));
    const byId = new Map(users.map((u) => [u.id, u]));
    // Pending access (plan 003 U6): brand-new people who haven't signed in yet. They
    // appear as email-only "Pending" rows (no userId) until their first verified login
    // materializes the membership. Suppress any whose email already became a member.
    const memberEmails = new Set(
      rows.map((m) => byId.get(m.userId)?.email).filter((e): e is string => !!e),
    );
    const pending = (await deps.invitations.listPendingForTarget("team", team.id))
      .filter((inv) => !memberEmails.has(inv.email))
      .map((inv) => ({ email: inv.email, invitedAt: inv.createdAt }));
    return c.json({
      members: rows.map((m) => {
        const u = byId.get(m.userId);
        return { userId: m.userId, email: u?.email ?? null, name: u?.name ?? null };
      }),
      pending,
    });
  });

  app.post("/:id/members", sameOrigin, async (c) => {
    const body = addMemberSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const r = await deps.service.addMemberByEmail(actorOf(c), c.req.param("id"), body.data.email);
    if (!r.ok) return c.json({ error: r.error }, HTTP[r.error]);
    // `granted`/`already_added` = an existing user is active now; `pending`/`already_pending`
    // = a brand-new person will join on their first verified login.
    return c.json({ ok: true, status: r.status });
  });

  app.delete("/:id/members/:userId", sameOrigin, async (c) => {
    const r = await deps.service.removeMember(actorOf(c), c.req.param("id"), c.req.param("userId"));
    if (!r.ok) return c.json({ error: r.error }, HTTP[r.error]);
    return c.json({ ok: true });
  });

  return app;
}

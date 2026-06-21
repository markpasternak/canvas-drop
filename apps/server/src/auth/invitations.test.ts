import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { type InvitationApplyDeps, materializePendingInvitations } from "./invitations.js";

describe.each(DIALECTS)("materialize-on-verified-login (plan 003 U4) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function harness() {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const teams = teamsRepository(client);
    const canvases = canvasesRepository(client);
    const invitations = invitationsRepository(client);
    const deps: InvitationApplyDeps = { invitations, teams, canvases };

    // The inviter (a real user the invitation references).
    const inviter = await users.upsert({
      providerSub: "dev:inviter",
      email: "inviter@e.com",
      name: "Inviter",
      isAdmin: false,
    });
    return { users, teams, canvases, invitations, deps, inviter };
  }

  it("a pending team invitation materializes a team_members row on first verified login; re-login does not double-apply", async () => {
    const { users, teams, invitations, deps, inviter } = await harness();
    const team = await teams.create({ orgId: null, name: "Friends", createdBy: inviter.id });
    await invitations.record({
      email: "invitee@x.com",
      target: { type: "team", id: team.id },
      invitedBy: inviter.id,
    });

    // Before the invitee logs in: the grant exists only as a pending row (no membership).
    const invitee = await users.upsert({
      providerSub: "dev:invitee",
      email: "invitee@x.com",
      name: "Invitee",
      isAdmin: false,
    });
    expect(await teams.isTeamMember(team.id, invitee.id)).toBe(false);

    // First verified login applies it.
    await materializePendingInvitations(deps, { id: invitee.id, email: "invitee@x.com" });
    expect(await teams.isTeamMember(team.id, invitee.id)).toBe(true);
    expect(await invitations.countPendingByActor(inviter.id)).toBe(0); // consumed

    // Re-login is a no-op: still exactly one membership row, nothing un-consumed.
    await materializePendingInvitations(deps, { id: invitee.id, email: "invitee@x.com" });
    const members = (await teams.getMembers(team.id)).filter((m) => m.userId === invitee.id);
    expect(members).toHaveLength(1);
  });

  it("identity is the verified login email only — a pending invitation never grants without a matching login", async () => {
    const { users, teams, invitations, deps, inviter } = await harness();
    const team = await teams.create({ orgId: null, name: "Family", createdBy: inviter.id });
    await invitations.record({
      email: "wanted@x.com",
      target: { type: "team", id: team.id },
      invitedBy: inviter.id,
    });

    // A DIFFERENT email signs in — the pending invitation for wanted@x.com must not apply.
    const other = await users.upsert({
      providerSub: "dev:other",
      email: "other@x.com",
      name: "Other",
      isAdmin: false,
    });
    await materializePendingInvitations(deps, { id: other.id, email: "other@x.com" });
    expect(await teams.isTeamMember(team.id, other.id)).toBe(false);
    expect(await invitations.countPendingByActor(inviter.id)).toBe(1); // still pending
  });

  it("a pending canvas invitation materializes a member allowlist row on first verified login", async () => {
    const { users, canvases, invitations, deps, inviter } = await harness();
    const cv = await canvases.create({ ownerId: inviter.id, slug: "deck-1", apiKeyHash: "h" });
    await invitations.record({
      email: "guest@x.com",
      target: { type: "canvas", id: cv.id },
      invitedBy: inviter.id,
    });
    const invitee = await users.upsert({
      providerSub: "dev:cg",
      email: "guest@x.com",
      name: "Guest",
      isAdmin: false,
    });

    await materializePendingInvitations(deps, { id: invitee.id, email: "guest@x.com" });
    expect(await canvases.isPrincipalAllowed(cv.id, { userId: invitee.id })).toBe(true);
  });

  it("concurrent logins don't double-create the membership (idempotent + consume-guarded)", async () => {
    const { users, teams, invitations, deps, inviter } = await harness();
    const team = await teams.create({ orgId: null, name: "Race", createdBy: inviter.id });
    await invitations.record({
      email: "race@x.com",
      target: { type: "team", id: team.id },
      invitedBy: inviter.id,
    });
    const invitee = await users.upsert({
      providerSub: "dev:race",
      email: "race@x.com",
      name: "Race",
      isAdmin: false,
    });

    // Two logins land at once.
    await Promise.all([
      materializePendingInvitations(deps, { id: invitee.id, email: "race@x.com" }),
      materializePendingInvitations(deps, { id: invitee.id, email: "race@x.com" }),
    ]);
    const members = (await teams.getMembers(team.id)).filter((m) => m.userId === invitee.id);
    expect(members).toHaveLength(1);
  });

  it("deleting a team clears its pending invitations, so a later login never FK-retries a vanished target (review fix)", async () => {
    const { users, teams, invitations, deps, inviter } = await harness();
    const team = await teams.create({ orgId: null, name: "Doomed", createdBy: inviter.id });
    await invitations.record({
      email: "late@x.com",
      target: { type: "team", id: team.id },
      invitedBy: inviter.id,
    });
    expect(await invitations.listForEmail("late@x.com")).toHaveLength(1);

    // The team is deleted before the invitee ever signs in.
    await teams.remove(team.id);
    // The pending invitation is gone (no orphaned row to FK-fail forever on every login).
    expect(await invitations.listForEmail("late@x.com")).toHaveLength(0);

    // A belated first login is a clean no-op: no membership materialized, no throw.
    const late = await users.upsert({
      providerSub: "dev:late",
      email: "late@x.com",
      name: "Late",
      isAdmin: false,
    });
    await materializePendingInvitations(deps, { id: late.id, email: "late@x.com" });
    expect(await teams.isTeamMember(team.id, late.id)).toBe(false);
  });

  it("record is idempotent on (email, target) — a duplicate invite does not stack the pending count", async () => {
    const { teams, invitations, inviter } = await harness();
    const team = await teams.create({ orgId: null, name: "Dup", createdBy: inviter.id });
    await invitations.record({
      email: "dup@x.com",
      target: { type: "team", id: team.id },
      invitedBy: inviter.id,
    });
    await invitations.record({
      email: "dup@x.com",
      target: { type: "team", id: team.id },
      invitedBy: inviter.id,
    });
    expect(await invitations.countPendingByActor(inviter.id)).toBe(1);
    expect(await invitations.listForEmail("dup@x.com")).toHaveLength(1);
  });
});

import { type Config, loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { allowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { makeInviteService } from "../invites/testing.js";
import { type TeamActor, teamsService } from "./service.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

describe.each(DIALECTS)("teamsService (plan 003 U3) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function setup() {
    client = await makeTestDb(dialect);
    const orgs = orgsRepository(client);
    const orgMembers = orgMembersRepository(client);
    const teams = teamsRepository(client);
    const users = usersRepository(client);
    const allowedEmails = allowedEmailsRepository(client);
    const invitations = invitationsRepository(client);
    const org = await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });
    const audit = { recordAudit: () => {} };
    const svc = teamsService({
      teams,
      orgMembers,
      users,
      invites: makeInviteService(client, config),
      audit,
    });

    /** Create a user + (for members) materialize their org membership. */
    async function mkUser(email: string, opts: { member?: boolean; admin?: boolean } = {}) {
      const u = await users.upsert({
        providerSub: email,
        email,
        name: email,
        isAdmin: !!opts.admin,
      });
      if (opts.member) await orgMembers.upsertDomainMember(org.id, u.id);
      return u;
    }
    const actor = (
      u: { id: string; isAdmin: boolean; email?: string; name?: string },
      member = true,
    ): TeamActor => ({
      id: u.id,
      isAdmin: u.isAdmin,
      orgIds: member ? new Set([org.id]) : new Set<string>(),
      name: u.name ?? u.email ?? "Actor",
      email: u.email ?? "actor@acme.com",
    });

    return { orgs, orgMembers, teams, users, allowedEmails, invitations, org, svc, mkUser, actor };
  }

  it("a member creates an org team; a non-member cannot attach to that org", async () => {
    const { svc, org, mkUser, actor } = await setup();
    const member = await mkUser("m@acme.com", { member: true });
    const ok = await svc.create(actor(member), { orgId: org.id, name: "Eng" });
    expect(ok.ok).toBe(true);

    const guest = await mkUser("g@gmail.com");
    const denied = await svc.create(actor(guest, false), { orgId: org.id, name: "Sneaky" });
    expect(denied).toEqual({ ok: false, error: "NOT_A_MEMBER" });
  });

  it("a no-org user (guest) CAN create a PERSONAL team (plan 003 phase 3)", async () => {
    const { svc, teams, mkUser, actor } = await setup();
    const guest = await mkUser("g@gmail.com"); // not an org member
    const r = await svc.create(actor(guest, false), { name: "Family" }); // no orgId → personal
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("setup");
    const team = await teams.findById(r.team.id);
    expect(team?.orgId).toBeNull();
    // The creator is auto a member, can manage it, and reuse the name across namespaces.
    expect((await svc.rename(actor(guest, false), r.team.id, "Family 2")).ok).toBe(true);
    expect(await svc.create(actor(guest, false), { name: "Family 2" })).toEqual({
      ok: false,
      error: "TEAM_NAME_TAKEN",
    });
  });

  it("a personal team accepts ANY existing user as a member (no same-org requirement)", async () => {
    const { svc, teams, mkUser, actor } = await setup();
    const owner = await mkUser("o@gmail.com"); // a no-org user
    await mkUser("friend@hotmail.com"); // another no-org user, exists
    const r = await svc.create(actor(owner, false), { name: "Friends" });
    if (!r.ok) throw new Error("setup");
    // A non-org friend can be added to a PERSONAL team (would be TARGET_NOT_MEMBER for an org team).
    expect(
      await svc.addMemberByEmail(actor(owner, false), r.team.id, "friend@hotmail.com"),
    ).toEqual({ ok: true, status: "granted" });
    expect(
      await svc.addMemberByEmail(actor(owner, false), r.team.id, "friend@hotmail.com"),
    ).toEqual({ ok: true, status: "already_added" });
    expect(await teams.getMembers(r.team.id)).toHaveLength(2);
  });

  it("a personal team records admitted external emails as pending and rejects inadmissible ones", async () => {
    const { svc, teams, allowedEmails, invitations, mkUser, actor } = await setup();
    const owner = await mkUser("o@gmail.com");
    const r = await svc.create(actor(owner, false), { name: "Friends" });
    if (!r.ok) throw new Error("setup");

    expect(
      await svc.addMemberByEmail(actor(owner, false), r.team.id, "stranger@external.test"),
    ).toEqual({ ok: false, error: "TARGET_NOT_PERMITTED" });
    expect(await teams.getMembers(r.team.id)).toHaveLength(1);
    expect(await invitations.listPendingForTarget("team", r.team.id)).toHaveLength(0);

    await allowedEmails.add("friend@external.test", owner.id);
    expect(
      await svc.addMemberByEmail(actor(owner, false), r.team.id, "friend@external.test"),
    ).toEqual({ ok: true, status: "pending" });
    expect(
      await svc.addMemberByEmail(actor(owner, false), r.team.id, "friend@external.test"),
    ).toEqual({ ok: true, status: "already_pending" });
    expect(await invitations.listPendingForTarget("team", r.team.id)).toHaveLength(1);
  });

  it("team names are creator-local: same creator can't dupe, different creators can reuse", async () => {
    const { svc, org, mkUser, actor } = await setup();
    const alice = await mkUser("a@acme.com", { member: true });
    const bob = await mkUser("b@acme.com", { member: true });

    expect((await svc.create(actor(alice), { orgId: org.id, name: "Design" })).ok).toBe(true);
    // Same creator, same name (case-insensitive) → rejected.
    expect(await svc.create(actor(alice), { orgId: org.id, name: "design" })).toEqual({
      ok: false,
      error: "TEAM_NAME_TAKEN",
    });
    // A DIFFERENT creator may reuse the name (teams are creator-local for naming).
    expect((await svc.create(actor(bob), { orgId: org.id, name: "Design" })).ok).toBe(true);
  });

  it("rename/delete: creator or operator only", async () => {
    const { svc, org, teams, mkUser, actor } = await setup();
    const creator = await mkUser("c@acme.com", { member: true });
    const other = await mkUser("o@acme.com", { member: true });
    const admin = await mkUser("a@acme.com", { member: true, admin: true });
    const created = await svc.create(actor(creator), { orgId: org.id, name: "Eng" });
    if (!created.ok) throw new Error("setup");
    const teamId = created.team.id;

    expect(await svc.rename(actor(other), teamId, "Hijack")).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
    expect((await svc.rename(actor(creator), teamId, "Engineering")).ok).toBe(true);
    expect((await svc.rename(actor(admin), teamId, "Eng2")).ok).toBe(true); // operator may
    expect(await svc.remove(actor(other), teamId)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect((await svc.remove(actor(creator), teamId)).ok).toBe(true);
    expect(await teams.findById(teamId)).toBeNull();
  });

  it("rename of a missing team → TEAM_NOT_FOUND", async () => {
    const { svc, mkUser, actor } = await setup();
    const u = await mkUser("m@acme.com", { member: true });
    expect(await svc.rename(actor(u), "no-such-team", "X")).toEqual({
      ok: false,
      error: "TEAM_NOT_FOUND",
    });
  });

  it("addMember: same-org member only, by a team member", async () => {
    const { svc, org, mkUser, actor } = await setup();
    const creator = await mkUser("c@acme.com", { member: true });
    await mkUser("k@acme.com", { member: true }); // an org member (addable)
    await mkUser("x@gmail.com"); // can sign in but is NOT an org member
    const stranger = await mkUser("s@acme.com", { member: true }); // org member, NOT in the team
    const created = await svc.create(actor(creator), { orgId: org.id, name: "Eng" });
    if (!created.ok) throw new Error("setup");
    const teamId = created.team.id;

    // unknown email
    expect(await svc.addMemberByEmail(actor(creator), teamId, "nobody@acme.com")).toEqual({
      ok: false,
      error: "TARGET_NOT_FOUND",
    });
    // an org member can be added; duplicate adds are an explicit no-op status.
    expect(await svc.addMemberByEmail(actor(creator), teamId, "k@acme.com")).toEqual({
      ok: true,
      status: "granted",
    });
    expect(await svc.addMemberByEmail(actor(creator), teamId, "k@acme.com")).toEqual({
      ok: true,
      status: "already_added",
    });
    // a non-org user cannot
    expect(await svc.addMemberByEmail(actor(creator), teamId, "x@gmail.com")).toEqual({
      ok: false,
      error: "TARGET_NOT_MEMBER",
    });
    // a non-team-member, non-admin actor cannot add (even though they're an org member)
    expect(await svc.addMemberByEmail(actor(stranger), teamId, "c@acme.com")).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
  });

  it("removeMember: self-leave always allowed; others need membership/operator", async () => {
    const { svc, org, teams, mkUser, actor } = await setup();
    const creator = await mkUser("c@acme.com", { member: true });
    const colleague = await mkUser("k@acme.com", { member: true });
    const created = await svc.create(actor(creator), { orgId: org.id, name: "Eng" });
    if (!created.ok) throw new Error("setup");
    const teamId = created.team.id;
    await svc.addMemberByEmail(actor(creator), teamId, "k@acme.com");

    // a non-member outsider cannot remove someone else
    const outsider = await mkUser("o@acme.com", { member: true });
    expect(await svc.removeMember(actor(outsider), teamId, colleague.id)).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
    // self-leave is always allowed
    expect((await svc.removeMember(actor(colleague), teamId, colleague.id)).ok).toBe(true);
    expect(await teams.isTeamMember(teamId, colleague.id)).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { type TeamActor, teamsService } from "./service.js";

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
    const org = await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });
    const audit = { recordAudit: () => {} };
    const svc = teamsService({ teams, orgMembers, users, audit });

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
    const actor = (u: { id: string; isAdmin: boolean }, member = true): TeamActor => ({
      id: u.id,
      isAdmin: u.isAdmin,
      orgIds: member ? new Set([org.id]) : new Set<string>(),
    });

    return { orgs, orgMembers, teams, users, org, svc, mkUser, actor };
  }

  it("a member creates a team; a guest cannot", async () => {
    const { svc, org, mkUser, actor } = await setup();
    const member = await mkUser("m@acme.com", { member: true });
    const ok = await svc.create(actor(member), { orgId: org.id, name: "Eng" });
    expect(ok.ok).toBe(true);

    const guest = await mkUser("g@gmail.com");
    const denied = await svc.create(actor(guest, false), { orgId: org.id, name: "Sneaky" });
    expect(denied).toEqual({ ok: false, error: "NOT_A_MEMBER" });
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
    // an org member can be added
    expect((await svc.addMemberByEmail(actor(creator), teamId, "k@acme.com")).ok).toBe(true);
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

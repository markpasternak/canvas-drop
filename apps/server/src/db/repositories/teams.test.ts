import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { orgMembersRepository } from "./org-members.js";
import { orgsRepository } from "./orgs.js";
import { teamsRepository } from "./teams.js";
import { usersRepository } from "./users.js";

describe.each(DIALECTS)("teamsRepository.teamMatch (plan 003 U4, KTD3) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seed() {
    client = await makeTestDb(dialect);
    const orgs = orgsRepository(client);
    const orgMembers = orgMembersRepository(client);
    const teams = teamsRepository(client);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const org = await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });
    const member = await users.upsert({
      providerSub: "m",
      email: "m@acme.com",
      name: "M",
      isAdmin: false,
    });
    const stranger = await users.upsert({
      providerSub: "s",
      email: "s@acme.com",
      name: "S",
      isAdmin: false,
    });
    await orgMembers.upsertDomainMember(org.id, member.id);
    const team = await teams.create({ orgId: org.id, name: "Eng", createdBy: member.id });
    const canvas = await canvases.create({ ownerId: member.id, slug: "deck", apiKeyHash: "k" });
    await teams.setCanvasTeams(canvas.id, [team.id]);
    return { orgs, teams, org, member, stranger, team, canvas };
  }

  it("a member of a granted team, in the team's org, matches", async () => {
    const { teams, org, member, canvas } = await seed();
    expect(await teams.teamMatch(canvas.id, member.id, new Set([org.id]))).toBe(true);
  });

  it("a non-team-member does NOT match (even as an org member)", async () => {
    const { teams, org, stranger, canvas } = await seed();
    expect(await teams.teamMatch(canvas.id, stranger.id, new Set([org.id]))).toBe(false);
  });

  it("a team member whose LIVE org membership is empty does NOT match (removed-from-org)", async () => {
    // The KTD3 re-join uses the live viewerOrgIds — a stale team_members row can't grant.
    const { teams, member, canvas } = await seed();
    expect(await teams.teamMatch(canvas.id, member.id, new Set())).toBe(false);
  });

  it("a member whose org is not the team's org does NOT match", async () => {
    const { teams, member, canvas } = await seed();
    expect(await teams.teamMatch(canvas.id, member.id, new Set(["some-other-org"]))).toBe(false);
  });

  it("a canvas with no team grants matches no one", async () => {
    const { teams, org, member, canvas } = await seed();
    await teams.setCanvasTeams(canvas.id, []);
    expect(await teams.teamMatch(canvas.id, member.id, new Set([org.id]))).toBe(false);
  });
});

describe.each(
  DIALECTS,
)("teamsRepository.teamMatch — PERSONAL teams (plan 003 phase 3) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** A PERSONAL team (org_id null) whose canvas is granted to it. The owner + a NO-ORG friend
   *  are members; a stranger is not. Personal teams grant by direct membership — the org
   *  re-join does not apply, so even an empty `viewerOrgIds` (a no-org user) reaches it. */
  async function seedPersonal() {
    client = await makeTestDb(dialect);
    const teams = teamsRepository(client);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@x.com",
      name: "O",
      isAdmin: false,
    });
    const friend = await users.upsert({
      providerSub: "f",
      email: "f@gmail.com",
      name: "F",
      isAdmin: false,
    });
    const stranger = await users.upsert({
      providerSub: "s",
      email: "s@x.com",
      name: "S",
      isAdmin: false,
    });
    // A personal team (no org). The creator is auto-added; add the no-org friend too.
    const team = await teams.create({ orgId: null, name: "Friends", createdBy: owner.id });
    await teams.addMember(team.id, friend.id);
    const canvas = await canvases.create({ ownerId: owner.id, slug: "p-deck", apiKeyHash: "k" });
    await teams.setCanvasTeams(canvas.id, [team.id]);
    return { teams, owner, friend, stranger, team, canvas };
  }

  it("the creator reaches their personal team canvas with NO orgs (dropped early return)", async () => {
    const { teams, owner, canvas } = await seedPersonal();
    expect(await teams.teamMatch(canvas.id, owner.id, new Set())).toBe(true);
  });

  it("a no-org friend who is a member reaches it (personal teams ignore org membership)", async () => {
    const { teams, friend, canvas } = await seedPersonal();
    expect(await teams.teamMatch(canvas.id, friend.id, new Set())).toBe(true);
    // …and the viewer's orgs are irrelevant to a personal team.
    expect(await teams.teamMatch(canvas.id, friend.id, new Set(["any-org"]))).toBe(true);
  });

  it("a non-member does NOT reach a personal team canvas", async () => {
    const { teams, stranger, canvas } = await seedPersonal();
    expect(await teams.teamMatch(canvas.id, stranger.id, new Set())).toBe(false);
    expect(await teams.teamMatch(canvas.id, stranger.id, new Set(["any-org"]))).toBe(false);
  });

  it("membership is MANDATORY: removing the team_members row immediately denies (both kinds)", async () => {
    const { teams, friend, canvas, team } = await seedPersonal();
    expect(await teams.teamMatch(canvas.id, friend.id, new Set())).toBe(true);
    await teams.removeMember(team.id, friend.id);
    expect(await teams.teamMatch(canvas.id, friend.id, new Set())).toBe(false);
  });

  it("listCanvasGrantsForUserTeams returns a personal team canvas for a no-org member", async () => {
    const { teams, friend, canvas } = await seedPersonal();
    expect(await teams.listCanvasGrantsForUserTeams(friend.id, new Set())).toEqual([
      expect.objectContaining({ canvasId: canvas.id, teamName: "Friends" }),
    ]);
    // A stranger gets nothing.
    const { teams: t2, stranger } = await seedPersonal();
    expect(await t2.listCanvasGrantsForUserTeams(stranger.id, new Set())).toEqual([]);
  });

  it("a creator can have a personal AND an org team of the same name (creator-local naming)", async () => {
    const { teams, owner } = await seedPersonal();
    // Same creator, same name, but personal vs a (would-be) org namespace are independent.
    expect(await teams.nameTakenByCreator(null, owner.id, "Friends")).toBe(true);
    expect(await teams.nameTakenByCreator(null, owner.id, "friends")).toBe(true); // case-insensitive
    expect(await teams.nameTakenByCreator("org-A", owner.id, "Friends")).toBe(false); // different namespace
  });
});

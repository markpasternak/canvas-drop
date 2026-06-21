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

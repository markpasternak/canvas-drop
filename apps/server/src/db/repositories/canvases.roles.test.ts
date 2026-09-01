import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { orgMembersRepository } from "./org-members.js";
import { orgsRepository } from "./orgs.js";
import { teamsRepository } from "./teams.js";
import { usersRepository } from "./users.js";

/**
 * Editor-roles plan U1: the role columns and the repository writes that set them
 * (KTD3 upsert semantics, KTD4 team grants, the KTD2/KTD9 edited-canvases query).
 */
describe.each(DIALECTS)("canvas access roles — repository writes [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seed() {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const teams = teamsRepository(client);
    const orgs = orgsRepository(client);
    const orgMembers = orgMembersRepository(client);
    const org = await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });
    const mk = (sub: string) =>
      users.upsert({ providerSub: sub, email: `${sub}@acme.com`, name: sub, isAdmin: false });
    const owner = await mk("owner");
    const colleague = await mk("colleague");
    const other = await mk("other");
    await orgMembers.upsertDomainMember(org.id, owner.id);
    await orgMembers.upsertDomainMember(org.id, colleague.id);
    await orgMembers.upsertDomainMember(org.id, other.id);
    const canvas = await canvases.create({ ownerId: owner.id, slug: "deck", apiKeyHash: "k" });
    return { users, canvases, teams, org, owner, colleague, other, canvas };
  }

  it("new rows default to viewer; addAllowlistEntry with a role applies it on insert", async () => {
    const { canvases, colleague, other, canvas } = await seed();
    const v = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: colleague.id,
    });
    expect(v.role).toBe("viewer");
    const e = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: other.id,
      role: "editor",
    });
    expect(e.role).toBe("editor");
    const g = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "guest",
      email: "friend@gmail.com",
    });
    expect(g.role).toBe("viewer");
  });

  it("re-adding with role editor promotes an existing viewer row; a role-less re-add never demotes", async () => {
    const { canvases, colleague, canvas } = await seed();
    const v = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: colleague.id,
    });
    expect(v.role).toBe("viewer");
    const promoted = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: colleague.id,
      role: "editor",
    });
    expect(promoted.id).toBe(v.id); // same row, role updated in place
    expect(promoted.role).toBe("editor");
    const untouched = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: colleague.id,
    });
    expect(untouched.id).toBe(v.id);
    expect(untouched.role).toBe("editor"); // omitted role → existing role kept
    expect(await canvases.listAllowlist(canvas.id)).toHaveLength(1);
  });

  it("a guest entry is never an editor (repo backstop for KD2)", async () => {
    const { canvases, canvas } = await seed();
    await expect(
      canvases.addAllowlistEntry({
        canvasId: canvas.id,
        principalKind: "guest",
        email: "friend@gmail.com",
        role: "editor",
      }),
    ).rejects.toThrow(/guest/);
    const g = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "guest",
      email: "friend@gmail.com",
    });
    // setAllowlistRole(editor) matches member rows only → no row updated.
    expect(await canvases.setAllowlistRole(canvas.id, g.id, "editor")).toBeNull();
    expect((await canvases.findAllowlistEntry(canvas.id, g.id))?.role).toBe("viewer");
  });

  it("setAllowlistRole is scoped to the canvas AND the entry id", async () => {
    const { canvases, owner, colleague, canvas } = await seed();
    const row = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: colleague.id,
    });
    const otherCanvas = await canvases.create({ ownerId: owner.id, slug: "two", apiKeyHash: "k2" });
    // Another canvas's id with this row's id never reaches the row.
    expect(await canvases.setAllowlistRole(otherCanvas.id, row.id, "editor")).toBeNull();
    expect((await canvases.findAllowlistEntry(canvas.id, row.id))?.role).toBe("viewer");
    const updated = await canvases.setAllowlistRole(canvas.id, row.id, "editor");
    expect(updated?.role).toBe("editor");
    expect((await canvases.findEditorGrant(canvas.id, colleague.id))?.id).toBe(row.id);
    const demoted = await canvases.setAllowlistRole(canvas.id, row.id, "viewer");
    expect(demoted?.role).toBe("viewer");
    expect(await canvases.findEditorGrant(canvas.id, colleague.id)).toBeNull();
  });

  it("setCanvasTeamRole upserts a grant with a role; listEditorTeamIds returns editor grants only", async () => {
    const { teams, org, owner, canvas } = await seed();
    const eng = await teams.create({ orgId: org.id, name: "Eng", createdBy: owner.id });
    const design = await teams.create({ orgId: org.id, name: "Design", createdBy: owner.id });
    await teams.setCanvasTeams(canvas.id, [eng.id]); // legacy replace-write → viewer role
    expect(await teams.listCanvasTeamGrants(canvas.id)).toEqual([
      expect.objectContaining({ teamId: eng.id, role: "viewer" }),
    ]);
    const grant = await teams.setCanvasTeamRole(canvas.id, design.id, "editor");
    expect(grant).toEqual(expect.objectContaining({ teamId: design.id, role: "editor" }));
    expect(await teams.listEditorTeamIds(canvas.id)).toEqual([design.id]);
    // Promote the existing viewer grant in place.
    await teams.setCanvasTeamRole(canvas.id, eng.id, "editor");
    expect((await teams.listEditorTeamIds(canvas.id)).sort()).toEqual([design.id, eng.id].sort());
    expect(await teams.listCanvasTeamGrants(canvas.id)).toHaveLength(2);
    expect(await teams.removeCanvasTeam(canvas.id, eng.id)).toBe(true);
    expect(await teams.removeCanvasTeam(canvas.id, eng.id)).toBe(false);
    expect(await teams.listEditorTeamIds(canvas.id)).toEqual([design.id]);
  });

  it("editorTeamMatch matches live members of editor-role teams only, under the live org clause", async () => {
    const { teams, org, owner, colleague, other, canvas } = await seed();
    const eng = await teams.create({ orgId: org.id, name: "Eng", createdBy: owner.id });
    await teams.addMember(eng.id, colleague.id);
    await teams.setCanvasTeamRole(canvas.id, eng.id, "viewer");
    expect(await teams.editorTeamMatch(canvas.id, colleague.id, new Set([org.id]))).toBe(false);
    await teams.setCanvasTeamRole(canvas.id, eng.id, "editor");
    expect(await teams.editorTeamMatch(canvas.id, colleague.id, new Set([org.id]))).toBe(true);
    // Not a team member → no match, even as an org member.
    expect(await teams.editorTeamMatch(canvas.id, other.id, new Set([org.id]))).toBe(false);
    // An org team requires the org in the LIVE set (removed-from-org → denied).
    expect(await teams.editorTeamMatch(canvas.id, colleague.id, new Set())).toBe(false);
    // Leaving the team drops the match on the next call.
    await teams.removeMember(eng.id, colleague.id);
    expect(await teams.editorTeamMatch(canvas.id, colleague.id, new Set([org.id]))).toBe(false);
  });

  it("listEditedCanvasIds: direct editor rows + editor-role team membership; never viewer rows/teams", async () => {
    const { canvases, teams, org, owner, colleague, canvas } = await seed();
    const scope = { tenancyActive: true, viewerOrgIds: new Set([org.id]) };
    const direct = canvas;
    const viaTeam = await canvases.create({
      ownerId: owner.id,
      slug: "via-team",
      apiKeyHash: "k2",
    });
    const viewerOnly = await canvases.create({
      ownerId: owner.id,
      slug: "viewer",
      apiKeyHash: "k3",
    });
    const viewerTeam = await canvases.create({
      ownerId: owner.id,
      slug: "vteam",
      apiKeyHash: "k4",
    });

    await canvases.addAllowlistEntry({
      canvasId: direct.id,
      principalKind: "member",
      userId: colleague.id,
      role: "editor",
    });
    await canvases.addAllowlistEntry({
      canvasId: viewerOnly.id,
      principalKind: "member",
      userId: colleague.id,
    });
    const eng = await teams.create({ orgId: org.id, name: "Eng", createdBy: owner.id });
    await teams.addMember(eng.id, colleague.id);
    await teams.setCanvasTeamRole(viaTeam.id, eng.id, "editor");
    await teams.setCanvasTeamRole(viewerTeam.id, eng.id, "viewer");

    const ids = await canvases.listEditedCanvasIds(colleague.id, scope);
    expect(ids.sort()).toEqual([direct.id, viaTeam.id].sort());
    // The owner never "edits" their own canvas.
    expect(await canvases.listEditedCanvasIds(owner.id, scope)).toEqual([]);
  });

  it("listEditedCanvasIds applies the live org predicate (KTD2)", async () => {
    const { canvases, teams, org, owner, colleague, canvas } = await seed();
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: colleague.id,
      role: "editor",
    });
    // Inert tenancy: any member qualifies.
    expect(
      await canvases.listEditedCanvasIds(colleague.id, {
        tenancyActive: false,
        viewerOrgIds: new Set(),
      }),
    ).toEqual([canvas.id]);
    // Active tenancy, empty live org set (a guest) → nothing.
    expect(
      await canvases.listEditedCanvasIds(colleague.id, {
        tenancyActive: true,
        viewerOrgIds: new Set(),
      }),
    ).toEqual([]);
    // Active tenancy, canvas homed in an org the caller is NOT in → nothing.
    const homed = await canvases.create({
      ownerId: owner.id,
      slug: "homed",
      apiKeyHash: "k5",
      orgId: org.id,
    });
    await canvases.addAllowlistEntry({
      canvasId: homed.id,
      principalKind: "member",
      userId: colleague.id,
      role: "editor",
    });
    expect(
      (
        await canvases.listEditedCanvasIds(colleague.id, {
          tenancyActive: true,
          viewerOrgIds: new Set(["some-other-org"]),
        })
      ).sort(),
    ).toEqual([canvas.id]); // the personal-space canvas still counts; the org-homed one does not
    expect(
      (
        await canvases.listEditedCanvasIds(colleague.id, {
          tenancyActive: true,
          viewerOrgIds: new Set([org.id]),
        })
      ).sort(),
    ).toEqual([canvas.id, homed.id].sort());
    // A personal team (no org) grants editor by membership alone, even to a no-org member
    // when tenancy is inert.
    const friends = await teams.create({ orgId: null, name: "Friends", createdBy: owner.id });
    await teams.addMember(friends.id, colleague.id);
    const personal = await canvases.create({
      ownerId: owner.id,
      slug: "personal",
      apiKeyHash: "k6",
    });
    await teams.setCanvasTeamRole(personal.id, friends.id, "editor");
    expect(
      await canvases.listEditedCanvasIds(colleague.id, {
        tenancyActive: false,
        viewerOrgIds: new Set(),
      }),
    ).toEqual(expect.arrayContaining([personal.id]));
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { memberPrincipal } from "../../canvas/authorization.js";
import { resolveManagementRole } from "../../canvas/role.js";
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
    expect((await canvases.findMemberEntry(canvas.id, colleague.id))?.role).toBe("editor");
    const demoted = await canvases.setAllowlistRole(canvas.id, row.id, "viewer");
    expect(demoted?.role).toBe("viewer");
    expect((await canvases.findMemberEntry(canvas.id, colleague.id))?.role).toBe("viewer");
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

  it("isEffectiveEditor: live members of editor-role teams only, under the live org clause", async () => {
    const { canvases, teams, org, owner, colleague, other, canvas } = await seed();
    const live = { tenancyActive: true, viewerOrgIds: new Set([org.id]) };
    const eng = await teams.create({ orgId: org.id, name: "Eng", createdBy: owner.id });
    await teams.addMember(eng.id, colleague.id);
    await teams.setCanvasTeamRole(canvas.id, eng.id, "viewer");
    expect(await canvases.isEffectiveEditor(canvas.id, colleague.id, live)).toBe(false);
    await teams.setCanvasTeamRole(canvas.id, eng.id, "editor");
    expect(await canvases.isEffectiveEditor(canvas.id, colleague.id, live)).toBe(true);
    // Not a team member → no match, even as an org member.
    expect(await canvases.isEffectiveEditor(canvas.id, other.id, live)).toBe(false);
    // An org team requires the org in the LIVE set (removed-from-org → denied).
    expect(
      await canvases.isEffectiveEditor(canvas.id, colleague.id, {
        tenancyActive: true,
        viewerOrgIds: new Set(),
      }),
    ).toBe(false);
    // Scoped per canvas: the grant on this canvas never reaches another.
    const other2 = await canvases.create({ ownerId: owner.id, slug: "other2", apiKeyHash: "k9" });
    expect(await canvases.isEffectiveEditor(other2.id, colleague.id, live)).toBe(false);
    // Leaving the team drops the match on the next call.
    await teams.removeMember(eng.id, colleague.id);
    expect(await canvases.isEffectiveEditor(canvas.id, colleague.id, live)).toBe(false);
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

// --- Owned-or-edited list (editor-roles plan U9, KTD9) -----------------------------------

describe.each(DIALECTS)("owned-or-edited list [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function fixtures(tenancyActive: boolean) {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const teams = teamsRepository(client);
    const orgs = orgsRepository(client);
    const orgMembers = orgMembersRepository(client);
    const org = await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });
    const other = await orgs.ensureOrg({ name: "Other", slug: "other", domains: ["other.com"] });
    const mk = (sub: string, domain = "acme.com") =>
      users.upsert({ providerSub: sub, email: `${sub}@${domain}`, name: sub, isAdmin: false });
    const owner = await mk("owner");
    const me = await mk("me");
    const outsider = await mk("outsider", "gmail.com");
    await orgMembers.upsertDomainMember(org.id, owner.id);
    await orgMembers.upsertDomainMember(org.id, me.id);
    const c = async (slug: string, extra: { orgId?: string; tags?: string[] } = {}) => {
      const cv = await canvases.create({
        ownerId: owner.id,
        slug,
        apiKeyHash: slug,
        orgId: extra.orgId ?? null,
      });
      if (extra.tags) await canvases.updateSettings(cv.id, { tags: extra.tags });
      return cv;
    };
    const mine = await c("mine");
    await canvases.updateSettings(mine.id, { tags: ["ops"] });
    const direct = await c("direct", { tags: ["design"] });
    const viaTeam = await c("via-team");
    const viewed = await c("viewed");
    const viewerTeam = await c("viewer-team");
    const crossOrg = await c("cross-org", { orgId: other.id });
    const personalTeam = await c("personal-team");
    const archived = await c("archived");
    // Ownership: `mine` is mine; everything else is the owner's.
    await canvases.transferOwner({
      canvasId: mine.id,
      fromUserId: owner.id,
      toUserId: me.id,
      previousOwnerEditor: false,
      revertPublicLink: false,
    });
    await canvases.addAllowlistEntry({
      canvasId: direct.id,
      principalKind: "member",
      userId: me.id,
      role: "editor",
    });
    await canvases.addAllowlistEntry({
      canvasId: viewed.id,
      principalKind: "member",
      userId: me.id,
    });
    await canvases.addAllowlistEntry({
      canvasId: crossOrg.id,
      principalKind: "member",
      userId: me.id,
      role: "editor",
    });
    await canvases.addAllowlistEntry({
      canvasId: archived.id,
      principalKind: "member",
      userId: me.id,
      role: "editor",
    });
    await canvases.archive(archived.id);
    const eng = await teams.create({ orgId: org.id, name: "Eng", createdBy: owner.id });
    await teams.addMember(eng.id, me.id);
    await teams.setCanvasTeamRole(viaTeam.id, eng.id, "editor");
    await teams.setCanvasTeamRole(viewerTeam.id, eng.id, "viewer");
    const friends = await teams.create({ orgId: null, name: "Friends", createdBy: owner.id });
    await teams.addMember(friends.id, me.id);
    await teams.addMember(friends.id, outsider.id);
    await teams.setCanvasTeamRole(personalTeam.id, friends.id, "editor");
    const scope = { tenancyActive, viewerOrgIds: new Set([org.id]) };
    return {
      canvases,
      users,
      org,
      owner,
      me,
      outsider,
      scope,
      ids: { mine, direct, viaTeam, viewed, viewerTeam, crossOrg, personalTeam, archived },
    };
  }

  it("AE9: lists owned + edited (direct / editor team / personal team), never viewer rows or viewer teams; role filter narrows", async () => {
    const { canvases, me, scope, ids } = await fixtures(false);
    const slugs = async (role?: "owned" | "edited", archived = false) =>
      (
        await canvases.listForActorFiltered({
          actorId: me.id,
          scope,
          role,
          archived,
          limit: 50,
          offset: 0,
        })
      ).items
        .map((cv) => cv.slug)
        .sort();
    // Inert tenancy: the cross-org canvas counts too (any member qualifies).
    expect(await slugs()).toEqual(["cross-org", "direct", "mine", "personal-team", "via-team"]);
    expect(await slugs("owned")).toEqual(["mine"]);
    expect(await slugs("edited")).toEqual(["cross-org", "direct", "personal-team", "via-team"]);
    // The owner's archived canvas appears under my archived toggle.
    expect(await slugs(undefined, true)).toEqual(["archived"]);
    void ids;
  });

  it("KTD2 in the list: under active tenancy the cross-org canvas drops out; an empty live org set lists only owned", async () => {
    const { canvases, me, org, scope } = await fixtures(true);
    const slugs = async (s = scope) =>
      (
        await canvases.listForActorFiltered({ actorId: me.id, scope: s, limit: 50, offset: 0 })
      ).items
        .map((cv) => cv.slug)
        .sort();
    expect(await slugs()).toEqual(["direct", "mine", "personal-team", "via-team"]);
    expect(await slugs({ tenancyActive: true, viewerOrgIds: new Set() })).toEqual(["mine"]);
    void org;
  });

  it("search, tag filter, and popular sort include edited canvases; total matches on both dialects", async () => {
    const { canvases, me, scope } = await fixtures(false);
    const byTag = await canvases.listForActorFiltered({
      actorId: me.id,
      scope,
      tag: ["design"],
      limit: 50,
      offset: 0,
    });
    expect(byTag.items.map((cv) => cv.slug)).toEqual(["direct"]);
    expect(byTag.total).toBe(1);
    const byQ = await canvases.listForActorFiltered({
      actorId: me.id,
      scope,
      q: "via",
      limit: 50,
      offset: 0,
    });
    expect(byQ.items.map((cv) => cv.slug)).toEqual(["via-team"]);
    const popular = await canvases.listForActorFiltered({
      actorId: me.id,
      scope,
      sort: "popular",
      limit: 2,
      offset: 0,
    });
    expect(popular.total).toBe(5);
    expect(popular.items).toHaveLength(2);
    const page2 = await canvases.listForActorFiltered({
      actorId: me.id,
      scope,
      limit: 2,
      offset: 4,
    });
    expect(page2.total).toBe(5);
    expect(page2.items).toHaveLength(1);
  });

  it("actorSummary counts the owned-or-edited set with the owned / edited split; tag facets span both", async () => {
    const { canvases, me, scope } = await fixtures(false);
    const summary = await canvases.actorSummary(me.id, scope);
    expect(summary).toMatchObject({ active: 5, archived: 1, owned: 1, edited: 4 });
    expect((await canvases.listActorTagFacets(me.id, scope)).sort()).toEqual(["design", "ops"]);
  });

  it("resolver agreement: every listed id resolves to owner/editor, and every effective editor is listed", async () => {
    const { canvases, users, me, outsider, org, scope } = await fixtures(true);
    const listed = (
      await canvases.listForActorFiltered({ actorId: me.id, scope, limit: 50, offset: 0 })
    ).items;
    const deps = { canvases, tenancyActive: true };
    for (const cv of listed) {
      const role = await resolveManagementRole(cv, memberPrincipal(me, new Set([org.id])), deps);
      expect(role, cv.slug).not.toBe("none");
    }
    // The outsider in the personal editor team (no org) under active tenancy: NOT an editor,
    // and not listed (AE14).
    const outsiderList = await canvases.listForActorFiltered({
      actorId: outsider.id,
      scope: { tenancyActive: true, viewerOrgIds: new Set() },
      limit: 50,
      offset: 0,
    });
    expect(outsiderList.items).toEqual([]);
    const personal = listed.find((cv) => cv.slug === "personal-team") as NonNullable<
      (typeof listed)[number]
    >;
    expect(await resolveManagementRole(personal, memberPrincipal(outsider, new Set()), deps)).toBe(
      "none",
    );
    // Managed ids = owned ∪ edited, the Shared exclusion set.
    const managed = await canvases.listManagedCanvasIds(me.id, scope);
    expect(managed.sort()).toEqual(
      [
        ...listed.map((cv) => cv.id),
        ...(
          await canvases.listForActorFiltered({
            actorId: me.id,
            scope,
            archived: true,
            limit: 50,
            offset: 0,
          })
        ).items.map((cv) => cv.id),
      ].sort(),
    );
    void users;
  });
});

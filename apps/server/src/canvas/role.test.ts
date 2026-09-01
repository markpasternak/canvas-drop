import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { Principal } from "../http/types.js";
import { memberPrincipal } from "./authorization.js";
import {
  loadManagementGrant,
  resolveCanvasRole,
  resolveManagementGrant,
  roleAtLeast,
} from "./role.js";

/**
 * The role resolver (editor-roles plan U2, KTD1/KTD2): owner → effective editor
 * (direct row or editor-role team, live org predicate) → viewer → none. Rejection
 * paths first (auth-invariant checklist).
 */
describe.each(DIALECTS)("resolveCanvasRole [%s]", (dialect) => {
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
    const otherOrg = await orgs.ensureOrg({ name: "Other", slug: "other", domains: ["other.com"] });
    const mk = (sub: string, domain = "acme.com", isAdmin = false) =>
      users.upsert({ providerSub: sub, email: `${sub}@${domain}`, name: sub, isAdmin });
    const owner = await mk("owner");
    const colleague = await mk("colleague");
    const admin = await mk("admin", "acme.com", true);
    await orgMembers.upsertDomainMember(org.id, owner.id);
    await orgMembers.upsertDomainMember(org.id, colleague.id);
    const canvas = await canvases.create({ ownerId: owner.id, slug: "deck", apiKeyHash: "k" });
    const inert = { canvases, tenancyActive: false };
    const active = { canvases, tenancyActive: true };
    const p = (u: { id: string; isAdmin: boolean }, ...orgIds: string[]) =>
      memberPrincipal(u, new Set(orgIds));
    return { canvases, teams, org, otherOrg, owner, colleague, admin, canvas, inert, active, p };
  }

  it("a member with no row is `none`; an admin with no row is `none` (no admin bypass)", async () => {
    const { canvas, colleague, admin, inert, active, org, p } = await seed();
    expect(await resolveCanvasRole(canvas, p(colleague, org.id), inert)).toBe("none");
    expect(await resolveCanvasRole(canvas, p(admin, org.id), inert)).toBe("none");
    expect(await resolveCanvasRole(canvas, p(admin, org.id), active)).toBe("none");
    expect(await resolveManagementGrant(canvas, p(admin, org.id), active)).toBeNull();
  });

  it("guest and anonymous principals never hold a role (KD2), whatever rows exist", async () => {
    const { canvases, canvas, inert } = await seed();
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "guest",
      email: "g@partner.com",
    });
    const guest: Principal = {
      kind: "guest",
      id: "guest:inv1",
      inviteId: "inv1",
      canvasId: canvas.id,
      email: "g@partner.com",
    };
    expect(await resolveCanvasRole(canvas, guest, inert)).toBe("none");
    expect(await resolveCanvasRole(canvas, { kind: "anonymous" }, inert)).toBe("none");
    expect(await resolveManagementGrant(canvas, guest, inert)).toBeNull();
  });

  it("owner is `owner` regardless of org membership; a deleted canvas grants nobody", async () => {
    const { canvases, canvas, owner, inert, active, p } = await seed();
    expect(await resolveCanvasRole(canvas, p(owner), inert)).toBe("owner");
    expect(await resolveCanvasRole(canvas, p(owner), active)).toBe("owner");
    await canvases.setStatus(canvas.id, "deleted");
    const gone = await canvases.findById(canvas.id);
    expect(await resolveManagementGrant(gone, p(owner), inert)).toBeNull();
    expect(await loadManagementGrant("missing", p(owner), inert)).toBeNull();
  });

  it("a direct editor row → editor; a direct viewer row → viewer (informational, no grant)", async () => {
    const { canvases, canvas, colleague, inert, org, p } = await seed();
    const row = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: colleague.id,
    });
    expect(await resolveCanvasRole(canvas, p(colleague, org.id), inert)).toBe("viewer");
    expect(await resolveManagementGrant(canvas, p(colleague, org.id), inert)).toBeNull();
    await canvases.setAllowlistRole(canvas.id, row.id, "editor");
    expect(await resolveCanvasRole(canvas, p(colleague, org.id), inert)).toBe("editor");
    const grant = await loadManagementGrant(canvas.id, p(colleague, org.id), inert);
    expect(grant?.role).toBe("editor");
    expect(grant?.canvas.id).toBe(canvas.id);
  });

  it("KTD2: an editor row whose live org set is EMPTY degrades to viewer under active tenancy, editor when inert (AE3)", async () => {
    const { canvases, canvas, colleague, inert, active, p } = await seed();
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: colleague.id,
      role: "editor",
    });
    expect(await resolveCanvasRole(canvas, p(colleague), active)).toBe("viewer");
    expect(await resolveManagementGrant(canvas, p(colleague), active)).toBeNull();
    expect(await resolveCanvasRole(canvas, p(colleague), inert)).toBe("editor");
  });

  it("KTD2: an org-homed canvas needs the editor in THAT org; a personal-space canvas takes any org member", async () => {
    const { canvases, owner, colleague, active, org, otherOrg, p } = await seed();
    const homed = await canvases.create({
      ownerId: owner.id,
      slug: "homed",
      apiKeyHash: "k2",
      orgId: org.id,
    });
    const personal = await canvases.create({ ownerId: owner.id, slug: "pers", apiKeyHash: "k3" });
    for (const cv of [homed, personal]) {
      await canvases.addAllowlistEntry({
        canvasId: cv.id,
        principalKind: "member",
        userId: colleague.id,
        role: "editor",
      });
    }
    // In a DIFFERENT org: no editor power on the org-homed canvas…
    expect(await resolveCanvasRole(homed, p(colleague, otherOrg.id), active)).toBe("viewer");
    // …but the personal-space canvas accepts any org member.
    expect(await resolveCanvasRole(personal, p(colleague, otherOrg.id), active)).toBe("editor");
    // In the home org: editor on both.
    expect(await resolveCanvasRole(homed, p(colleague, org.id), active)).toBe("editor");
    expect(await resolveCanvasRole(personal, p(colleague, org.id), active)).toBe("editor");
  });

  it("an editor-role team grants editor to its LIVE members; leaving the team or the org drops it (AE3)", async () => {
    const { canvases, teams, canvas, owner, colleague, active, org, p } = await seed();
    const eng = await teams.create({ orgId: org.id, name: "Eng", createdBy: owner.id });
    await teams.setCanvasTeamRole(canvas.id, eng.id, "editor");
    // Not yet a member → none.
    expect(await resolveCanvasRole(canvas, p(colleague, org.id), active)).toBe("none");
    await teams.addMember(eng.id, colleague.id);
    expect(await resolveCanvasRole(canvas, p(colleague, org.id), active)).toBe("editor");
    // Org departure (live set empty) → no role on the next request.
    expect(await resolveCanvasRole(canvas, p(colleague), active)).toBe("none");
    // A viewer-role team never confers editor.
    await teams.setCanvasTeamRole(canvas.id, eng.id, "viewer");
    expect(await resolveCanvasRole(canvas, p(colleague, org.id), active)).toBe("none");
    await teams.setCanvasTeamRole(canvas.id, eng.id, "editor");
    await teams.removeMember(eng.id, colleague.id);
    expect(await resolveCanvasRole(canvas, p(colleague, org.id), active)).toBe("none");
    // The owner in an editor team is still the owner (AE18).
    await teams.addMember(eng.id, owner.id);
    expect(await resolveCanvasRole(canvas, p(owner, org.id), active)).toBe("owner");
    expect(
      await canvases.isEffectiveEditor(canvas.id, owner.id, {
        tenancyActive: true,
        viewerOrgIds: new Set([org.id]),
      }),
    ).toBe(true);
    await teams.removeMember(eng.id, owner.id);
    expect(await resolveCanvasRole(canvas, p(owner, org.id), active)).toBe("owner");
  });

  it("roleAtLeast ranks none < viewer < editor < owner", () => {
    expect(roleAtLeast("owner", "owner")).toBe(true);
    expect(roleAtLeast("owner", "editor")).toBe(true);
    expect(roleAtLeast("editor", "owner")).toBe(false);
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(roleAtLeast("none", "viewer")).toBe(false);
  });
});

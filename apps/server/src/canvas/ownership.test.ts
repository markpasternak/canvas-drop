import { afterEach, describe, expect, it } from "vitest";
import type { AuditLog, RecordAuditInput } from "../audit/audit-log.js";
import { makeOrgMembershipResolver } from "../auth/org-membership.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { memberPrincipal } from "./authorization.js";
import { type OwnershipNotifier, ownershipService } from "./ownership.js";
import { resolveManagementRole } from "./role.js";

/**
 * Ownership transfer + admin reassign (editor-roles plan U7, KTD7): one atomic service.
 * Rejection paths first; the people list never ends with duplicates; the audit names
 * both parties; sockets are revalidated.
 */
describe.each(DIALECTS)("ownershipService [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seed(tenancyActive = false) {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const teams = teamsRepository(client);
    const orgs = orgsRepository(client);
    const orgMembers = orgMembersRepository(client);
    const org = await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });
    const mk = (sub: string, domain = "acme.com") =>
      users.upsert({ providerSub: sub, email: `${sub}@${domain}`, name: sub, isAdmin: false });
    const owner = await mk("owner");
    const editor = await mk("editor");
    const viewer = await mk("viewer");
    const nobody = await mk("nobody");
    const outsider = await mk("outsider", "other.com");
    const admin = await mk("admin");
    const canvas = await canvases.create({ ownerId: owner.id, slug: "deck", apiKeyHash: "k0" });
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: viewer.id,
    });
    const events: RecordAuditInput[] = [];
    const audit: AuditLog = {
      recordAudit: (e) => {
        events.push(e);
      },
      flush: async () => {},
      record: () => {},
    };
    const revalidated: string[] = [];
    const notices: Array<{ kind: string; to: string; [k: string]: unknown }> = [];
    const notify: OwnershipNotifier = {
      async notifyOwnershipReceived(i) {
        notices.push({ kind: "received", ...i });
      },
      async notifyOwnershipReassignedAway(i) {
        notices.push({ kind: "reassigned", ...i });
      },
    };
    const svc = ownershipService({
      canvases,
      users,
      orgMembership: makeOrgMembershipResolver(orgs, orgMembers),
      tenancyActive,
      audit,
      hub: {
        revalidateCanvas: async (id) => {
          revalidated.push(id);
        },
      },
      notify,
    });
    const fresh = async () =>
      (await canvases.findById(canvas.id)) as NonNullable<
        Awaited<ReturnType<typeof canvases.findById>>
      >;
    const roleOf = async (u: { id: string; isAdmin: boolean }, ...orgIds: string[]) =>
      resolveManagementRole(await fresh(), memberPrincipal(u, new Set(orgIds)), {
        canvases,
        tenancyActive,
      });
    return {
      users,
      canvases,
      teams,
      org,
      owner,
      editor,
      viewer,
      nobody,
      outsider,
      admin,
      canvas: await fresh(),
      fresh,
      roleOf,
      svc,
      events,
      revalidated,
      notices,
    };
  }

  it("refuses: a non-editor member (NOT_ELIGIBLE), a team id / unknown id (TARGET_NOT_FOUND), the owner themselves (ALREADY_OWNER), a blocked editor (TARGET_BLOCKED)", async () => {
    const { svc, users, teams, canvas, owner, editor, viewer, nobody, fresh } = await seed();
    const actor = { id: owner.id, name: "owner" };
    expect(await svc.transfer(canvas, actor, viewer.id)).toMatchObject({ code: "NOT_ELIGIBLE" });
    expect(await svc.transfer(canvas, actor, nobody.id)).toMatchObject({ code: "NOT_ELIGIBLE" });
    const team = await teams.create({ orgId: null, name: "T", createdBy: owner.id });
    expect(await svc.transfer(canvas, actor, team.id)).toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(await svc.transfer(canvas, actor, owner.id)).toMatchObject({ code: "ALREADY_OWNER" });
    await users.setBlocked(editor.id, true);
    expect(await svc.transfer(canvas, actor, editor.id)).toMatchObject({ code: "TARGET_BLOCKED" });
    expect((await fresh()).ownerId).toBe(owner.id);
  });

  it("AE7: transfers to a direct editor — recipient owns, previous owner holds a direct editor row, audit names both, sockets revalidated, recipient notified", async () => {
    const { svc, canvases, canvas, owner, editor, roleOf, events, revalidated, notices } =
      await seed();
    const r = await svc.transfer(canvas, { id: owner.id, name: "owner" }, editor.id);
    expect(r).toMatchObject({
      ok: true,
      previousOwnerEditor: true,
      publicLinkReverted: false,
      deployKeyRotated: false,
    });
    expect(await roleOf(editor)).toBe("owner");
    expect(await roleOf(owner)).toBe("editor");
    // One row each (AE16): the recipient's old row is gone; the previous owner has one editor row.
    const rows = await canvases.listAllowlist(canvas.id);
    expect(rows.filter((e) => e.userId === editor.id)).toEqual([]);
    expect(rows.filter((e) => e.userId === owner.id).map((e) => e.role)).toEqual(["editor"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "canvas_transfer",
        actorId: owner.id,
        targetId: canvas.id,
        meta: expect.objectContaining({ from: owner.id, to: editor.id }),
      }),
    );
    expect(revalidated).toEqual([canvas.id]);
    expect(notices).toEqual([
      expect.objectContaining({ kind: "received", to: editor.email, mode: "transfer" }),
    ]);
  });

  it("AE16: recipient held a viewer row and edits via a team; owner had no row → exactly one row each afterwards", async () => {
    const { svc, canvases, teams, canvas, owner, viewer, org } = await seed();
    const eng = await teams.create({ orgId: org.id, name: "Eng", createdBy: owner.id });
    await teams.addMember(eng.id, viewer.id);
    await teams.setCanvasTeamRole(canvas.id, eng.id, "editor");
    const r = await svc.transfer(canvas, { id: owner.id, name: "owner" }, viewer.id);
    expect(r).toMatchObject({ ok: true, previousOwnerEditor: true });
    const rows = await canvases.listAllowlist(canvas.id);
    expect(rows.filter((e) => e.userId === viewer.id)).toEqual([]);
    expect(rows.filter((e) => e.userId === owner.id)).toHaveLength(1);
    expect(rows.find((e) => e.userId === owner.id)?.role).toBe("editor");
  });

  it("KTD2 at transfer: under active tenancy the recipient must be an org member; the previous owner keeps editor only if they pass the predicate", async () => {
    const { svc, canvases, canvas, owner, outsider, editor, org } = await seed(true);
    // An outsider (non-org email) holding an editor row is NOT an effective editor → refused.
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: outsider.id,
      role: "editor",
    });
    expect(await svc.transfer(canvas, { id: owner.id, name: "o" }, outsider.id)).toMatchObject({
      code: "NOT_ELIGIBLE",
    });
    // An in-org editor succeeds; the in-org previous owner keeps editor.
    const r = await svc.transfer(canvas, { id: owner.id, name: "o" }, editor.id);
    expect(r).toMatchObject({ ok: true, previousOwnerEditor: true });
    void org;
  });

  it("public_link + recipient without the entitlement → rung reverted, reported, audited", async () => {
    const { svc, canvases, users, canvas, owner, editor, fresh, events } = await seed();
    await users.setPublishPublic(owner.id, true);
    await users.setPublishPublic(editor.id, false);
    await canvases.setAccess(canvas.id, "public_link");
    const r = await svc.transfer(await fresh(), { id: owner.id, name: "o" }, editor.id);
    expect(r).toMatchObject({ ok: true, publicLinkReverted: true });
    expect((await fresh()).access).toBe("private");
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "canvas_transfer",
        meta: expect.objectContaining({ publicLinkReverted: true }),
      }),
    );
    // With the entitlement, the rung stays.
    const {
      svc: svc2,
      canvases: c2,
      users: u2,
      canvas: cv2,
      owner: o2,
      editor: e2,
      fresh: f2,
    } = await seed();
    await u2.setPublishPublic(o2.id, true);
    await u2.setPublishPublic(e2.id, true);
    await c2.setAccess(cv2.id, "public_link");
    expect(await svc2.transfer(await f2(), { id: o2.id, name: "o" }, e2.id)).toMatchObject({
      ok: true,
      publicLinkReverted: false,
    });
    expect((await f2()).access).toBe("public_link");
  });

  it("two transfers racing on the same observed owner → exactly one succeeds (conditional swap)", async () => {
    const { svc, canvases, canvas, owner, editor, viewer, fresh } = await seed();
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: viewer.id,
      role: "editor",
    });
    const results = await Promise.all([
      svc.transfer(canvas, { id: owner.id, name: "o" }, editor.id),
      svc.transfer(canvas, { id: owner.id, name: "o" }, viewer.id),
    ]);
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "CONFLICT" });
    const finalOwner = (await fresh()).ownerId;
    expect([editor.id, viewer.id]).toContain(finalOwner);
  });

  it("a failure after the editor row is written leaves the previous owner with access (write order is the safety net)", async () => {
    const { canvases, canvas, owner, roleOf } = await seed();
    // Force the swap to fail AFTER step 1: a recipient that violates the users FK.
    await expect(
      canvases.transferOwner({
        canvasId: canvas.id,
        fromUserId: owner.id,
        toUserId: "no-such-user",
        previousOwnerEditor: true,
        revertPublicLink: false,
      }),
    ).rejects.toThrow();
    // Either the transaction rolled back (still owner) or the editor row survived (editor):
    // never "no access".
    expect(["owner", "editor"]).toContain(await roleOf(owner));
  });

  it("previous owner whose account is blocked gets no editor row", async () => {
    const { svc, users, canvases, canvas, owner, editor } = await seed();
    await users.setBlocked(owner.id, true);
    const r = await svc.transfer(canvas, { id: owner.id, name: "o" }, editor.id);
    expect(r).toMatchObject({ ok: true, previousOwnerEditor: false });
    expect((await canvases.listAllowlist(canvas.id)).filter((e) => e.userId === owner.id)).toEqual(
      [],
    );
  });

  describe("admin reassign", () => {
    it("AE17 refusals: current owner (ALREADY_OWNER), blocked (TARGET_BLOCKED), the acting admin (SELF), unknown (TARGET_NOT_FOUND)", async () => {
      const { svc, users, canvas, owner, nobody, admin, fresh } = await seed();
      const a = { id: admin.id, name: "admin" };
      expect(await svc.reassign(canvas, a, owner.id, "r")).toMatchObject({ code: "ALREADY_OWNER" });
      expect(await svc.reassign(canvas, a, admin.id, "r")).toMatchObject({ code: "SELF" });
      expect(await svc.reassign(canvas, a, "nope", "r")).toMatchObject({
        code: "TARGET_NOT_FOUND",
      });
      await users.setBlocked(nobody.id, true);
      expect(await svc.reassign(canvas, a, nobody.id, "r")).toMatchObject({
        code: "TARGET_BLOCKED",
      });
      expect((await fresh()).ownerId).toBe(owner.id);
    });

    it("under active tenancy the target must be a member of the canvas's org (TARGET_NOT_MEMBER)", async () => {
      const { svc, canvases, owner, outsider, nobody, admin, org } = await seed(true);
      const homed = await canvases.create({
        ownerId: owner.id,
        slug: "homed",
        apiKeyHash: "k",
        orgId: org.id,
      });
      expect(
        await svc.reassign(homed, { id: admin.id, name: "a" }, outsider.id, "r"),
      ).toMatchObject({
        code: "TARGET_NOT_MEMBER",
      });
      expect(await svc.reassign(homed, { id: admin.id, name: "a" }, nobody.id, "r")).toMatchObject({
        ok: true,
      });
      // A personal-space canvas takes any org member — but never a no-org account.
      const personal = await canvases.create({ ownerId: owner.id, slug: "pers", apiKeyHash: "k2" });
      expect(
        await svc.reassign(personal, { id: admin.id, name: "a" }, outsider.id, "r"),
      ).toMatchObject({
        code: "TARGET_NOT_MEMBER",
      });
    });

    it("AE8/AE17: reassigns to an active member with the reason audited; an existing editor target loses their row; other editors untouched; key rotated; both parties notified", async () => {
      const {
        svc,
        canvases,
        canvas,
        owner,
        editor,
        viewer,
        admin,
        fresh,
        roleOf,
        events,
        revalidated,
        notices,
      } = await seed();
      const before = (await fresh()).apiKeyHash;
      const r = await svc.reassign(
        canvas,
        { id: admin.id, name: "admin" },
        editor.id,
        "owner left the company",
      );
      expect(r).toMatchObject({ ok: true, previousOwnerEditor: true, deployKeyRotated: true });
      expect((r as { canvas: { apiKeyHash: string } }).canvas.apiKeyHash).not.toBe(before);
      expect((await fresh()).apiKeyHash).not.toBe(before);
      expect(await roleOf(editor)).toBe("owner");
      expect(await roleOf(owner)).toBe("editor");
      // The acting admin gained nothing on the canvas.
      expect(await roleOf({ id: admin.id, isAdmin: true })).toBe("none");
      const rows = await canvases.listAllowlist(canvas.id);
      expect(rows.filter((e) => e.userId === editor.id)).toEqual([]);
      expect(rows.find((e) => e.userId === viewer.id)?.role).toBe("viewer");
      expect(events).toContainEqual(
        expect.objectContaining({
          action: "canvas_reassign_owner",
          actorId: admin.id,
          meta: expect.objectContaining({
            from: owner.id,
            to: editor.id,
            reason: "owner left the company",
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          action: "key_regen",
          actorId: admin.id,
          meta: expect.objectContaining({ byRole: "admin" }),
        }),
      );
      expect(revalidated).toEqual([canvas.id]);
      expect(notices).toEqual([
        expect.objectContaining({ kind: "received", to: editor.email, mode: "reassign" }),
        expect.objectContaining({
          kind: "reassigned",
          to: owner.email,
          newOwnerEmail: editor.email,
        }),
      ]);
    });

    it("a blocked outgoing owner gets no editor row and no notice", async () => {
      const { svc, users, canvases, canvas, owner, nobody, admin, notices } = await seed();
      await users.setBlocked(owner.id, true);
      const r = await svc.reassign(canvas, { id: admin.id, name: "a" }, nobody.id, "offboarding");
      expect(r).toMatchObject({ ok: true, previousOwnerEditor: false });
      expect(
        (await canvases.listAllowlist(canvas.id)).filter((e) => e.userId === owner.id),
      ).toEqual([]);
      expect(notices.map((n) => n.kind)).toEqual(["received"]);
    });
  });
});

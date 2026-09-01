import { type Config, loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditLog, RecordAuditInput } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { makeInviteService } from "../invites/testing.js";
import { type PeopleActor, peopleService } from "./people-service.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

/**
 * The shared people-list mutation layer (editor-roles plan U4/U5): the one implementation
 * both HTTP and MCP wrap. Rejection paths first; every change audited with the actor;
 * access-narrowing changes revalidate live sockets.
 */
describe.each(DIALECTS)("peopleService [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seed() {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const teams = teamsRepository(client);
    const invitations = invitationsRepository(client);
    const mk = (sub: string) =>
      users.upsert({ providerSub: sub, email: `${sub}@example.com`, name: sub, isAdmin: false });
    const owner = await mk("owner");
    const e1 = await mk("e1");
    const e2 = await mk("e2");
    const viewer = await mk("viewer");
    const canvas = await canvases.create({ ownerId: owner.id, slug: "deck", apiKeyHash: "k" });
    const other = await canvases.create({ ownerId: owner.id, slug: "other", apiKeyHash: "k2" });
    const e1Row = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: e1.id,
      role: "editor",
    });
    const e2Row = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: e2.id,
      role: "editor",
    });
    const viewerRow = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: viewer.id,
    });
    const guestRow = await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "guest",
      email: "g@partner.com",
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
    const hub = {
      revalidateCanvas: async (id: string) => {
        revalidated.push(id);
      },
    };
    const svc = peopleService({
      canvases,
      users,
      invitations,
      teams,
      invites: makeInviteService(client, config),
      audit,
      hub,
    });
    const actor = (u: { id: string; email: string; name: string }, role: PeopleActor["role"]) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      isAdmin: false,
      role,
    });
    const cv = (await canvases.findById(canvas.id)) as NonNullable<
      Awaited<ReturnType<typeof canvases.findById>>
    >;
    return {
      users,
      canvases,
      teams,
      invitations,
      owner,
      e1,
      e2,
      viewer,
      canvas: cv,
      other,
      e1Row,
      e2Row,
      viewerRow,
      guestRow,
      events,
      revalidated,
      svc,
      actor,
    };
  }

  it("lists the owner first with stable prefixed ids and roles (KTD5)", async () => {
    const { svc, canvas, owner, e1Row, viewerRow, guestRow } = await seed();
    const entries = await svc.list(canvas);
    expect(entries[0]).toMatchObject({
      id: "owner",
      kind: "owner",
      role: "owner",
      userId: owner.id,
    });
    expect(entries.find((e) => e.id === `member:${e1Row.id}`)).toMatchObject({
      kind: "member",
      role: "editor",
    });
    expect(entries.find((e) => e.id === `member:${viewerRow.id}`)).toMatchObject({
      kind: "member",
      role: "viewer",
    });
    expect(entries.find((e) => e.id === `guest:${guestRow.id}`)).toMatchObject({
      kind: "guest",
      role: "viewer",
      email: "g@partner.com",
    });
  });

  it("AE1: setting a guest entry to editor is refused GUEST_VIEWER_ONLY; viewer is a no-op", async () => {
    const { svc, canvas, owner, guestRow, actor, events } = await seed();
    const r = await svc.setRole(canvas, actor(owner, "owner"), `guest:${guestRow.id}`, "editor");
    expect(r).toMatchObject({ ok: false, code: "GUEST_VIEWER_ONLY" });
    expect(
      await svc.setRole(canvas, actor(owner, "owner"), `guest:${guestRow.id}`, "viewer"),
    ).toEqual({
      ok: true,
    });
    expect(events).toEqual([]);
  });

  it("the owner entry is owner-only for EVERYONE — set-role and remove refuse OWNER_ONLY", async () => {
    const { svc, canvas, owner, e1, actor } = await seed();
    for (const a of [actor(owner, "owner"), actor(e1, "editor")]) {
      expect(await svc.setRole(canvas, a, "owner", "viewer")).toMatchObject({
        ok: false,
        code: "OWNER_ONLY",
      });
      expect(await svc.remove(canvas, a, "owner")).toMatchObject({ ok: false, code: "OWNER_ONLY" });
    }
  });

  it("promotes a viewer via the entry id: role updated, audited as allowlist_role_change, sockets revalidated", async () => {
    const { svc, canvases, canvas, owner, viewer, viewerRow, actor, events, revalidated } =
      await seed();
    const r = await svc.setRole(canvas, actor(owner, "owner"), `member:${viewerRow.id}`, "editor");
    expect(r).toEqual({ ok: true });
    expect((await canvases.findMemberEntry(canvas.id, viewer.id))?.role).toBe("editor");
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "allowlist_role_change",
        actorId: owner.id,
        targetId: canvas.id,
        meta: expect.objectContaining({ role: "editor", from: "viewer", userId: viewer.id }),
      }),
    );
    expect(revalidated).toEqual([canvas.id]);
    // A legacy bare row id still addresses the row.
    expect(await svc.setRole(canvas, actor(owner, "owner"), viewerRow.id, "viewer")).toEqual({
      ok: true,
    });
    expect((await canvases.findMemberEntry(canvas.id, viewer.id))?.role).toBe("viewer");
  });

  it("an entry id from canvas B never reaches canvas A (404, row unchanged)", async () => {
    const { svc, canvases, canvas, other, owner, e1, e1Row, actor } = await seed();
    const otherCv = (await canvases.findById(other.id)) as typeof canvas;
    expect(
      await svc.setRole(otherCv, actor(owner, "owner"), `member:${e1Row.id}`, "viewer"),
    ).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await svc.remove(otherCv, actor(owner, "owner"), `member:${e1Row.id}`)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect((await canvases.findMemberEntry(canvas.id, e1.id))?.role).toBe("editor");
    // A kind prefix that disagrees with the row is not-found either.
    expect(await svc.remove(canvas, actor(owner, "owner"), `guest:${e1Row.id}`)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("AE5: editor E1 removes editor E2 (audited with E1 as actor); E1 may demote themselves", async () => {
    const { svc, canvases, canvas, e1, e2, e1Row, e2Row, actor, events } = await seed();
    expect(await svc.remove(canvas, actor(e1, "editor"), `member:${e2Row.id}`)).toEqual({
      ok: true,
    });
    expect(await canvases.findMemberEntry(canvas.id, e2.id)).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "allowlist_remove",
        actorId: e1.id,
        meta: expect.objectContaining({ kind: "member", role: "editor", userId: e2.id }),
      }),
    );
    expect(await svc.setRole(canvas, actor(e1, "editor"), `member:${e1Row.id}`, "viewer")).toEqual({
      ok: true,
    });
    expect((await canvases.findMemberEntry(canvas.id, e1.id))?.role).toBe("viewer");
  });

  it("add-with-role: an existing viewer is promoted (role_changed); a role-less re-add of an editor leaves them an editor", async () => {
    const { svc, canvases, canvas, owner, viewer, e1, actor, events } = await seed();
    const promoted = await svc.addPerson(canvas, actor(owner, "owner"), {
      email: viewer.email,
      role: "editor",
      mode: "add",
    });
    expect(promoted).toMatchObject({
      ok: true,
      result: { status: "role_changed", from: "viewer" },
    });
    expect((await canvases.findMemberEntry(canvas.id, viewer.id))?.role).toBe("editor");
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "allowlist_role_change",
        meta: expect.objectContaining({ role: "editor", from: "viewer" }),
      }),
    );
    const readd = await svc.addPerson(canvas, actor(owner, "owner"), {
      email: e1.email,
      mode: "add",
    });
    expect(readd).toMatchObject({ ok: true, result: { status: "already_added" } });
    expect((await canvases.findMemberEntry(canvas.id, e1.id))?.role).toBe("editor");
    // A brand-new member added with role editor lands as editor and is audited with the role.
    const fresh = await usersRepository(client).upsert({
      providerSub: "fresh",
      email: "fresh@example.com",
      name: "fresh",
      isAdmin: false,
    });
    const added = await svc.addPerson(canvas, actor(owner, "owner"), {
      email: fresh.email,
      role: "editor",
      mode: "add",
    });
    expect(added).toMatchObject({ ok: true, result: { status: "granted" }, role: "editor" });
    expect((await canvases.findMemberEntry(canvas.id, fresh.id))?.role).toBe("editor");
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "allowlist_add",
        meta: expect.objectContaining({ role: "editor", status: "granted" }),
      }),
    );
  });

  it("teams (U5): add a team with a role, change it, remove it — actor must be a member (TEAM_FORBIDDEN otherwise)", async () => {
    const { svc, teams, canvases, canvas, owner, e1, viewer, actor, events, revalidated } =
      await seed();
    const design = await teams.create({ orgId: null, name: "Design", createdBy: owner.id });
    await teams.addMember(design.id, viewer.id);
    // e1 is not a member of Design → cannot grant it.
    expect(
      await svc.addTeam(canvas, actor(e1, "editor"), { teamId: design.id, role: "editor" }),
    ).toMatchObject({ ok: false, code: "TEAM_FORBIDDEN" });
    expect(
      await svc.addTeam(canvas, actor(owner, "owner"), { teamId: design.id, role: "editor" }),
    ).toEqual({ ok: true });
    expect(await svc.list(canvas)).toContainEqual(
      expect.objectContaining({
        id: `team:${design.id}`,
        kind: "team",
        role: "editor",
        name: "Design",
      }),
    );
    // Its member is now an effective editor.
    expect(
      await canvases.isEffectiveEditor(canvas.id, viewer.id, {
        tenancyActive: false,
        viewerOrgIds: new Set(),
      }),
    ).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "share_change",
        meta: expect.objectContaining({ kind: "team_grant", teamId: design.id, role: "editor" }),
      }),
    );
    // Demote the team → members lose editor; sockets revalidated.
    revalidated.length = 0;
    expect(await svc.setRole(canvas, actor(owner, "owner"), `team:${design.id}`, "viewer")).toEqual(
      {
        ok: true,
      },
    );
    expect(revalidated).toEqual([canvas.id]);
    expect(
      await canvases.isEffectiveEditor(canvas.id, viewer.id, {
        tenancyActive: false,
        viewerOrgIds: new Set(),
      }),
    ).toBe(false);
    expect(await svc.remove(canvas, actor(owner, "owner"), `team:${design.id}`)).toEqual({
      ok: true,
    });
    expect(await teams.listCanvasTeamGrants(canvas.id)).toEqual([]);
    expect(await svc.remove(canvas, actor(owner, "owner"), `team:${design.id}`)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("pending invitees carry a role: set-role updates the pending row; remove cancels it", async () => {
    const { svc, invitations, canvas, owner, actor, events } = await seed();
    await invitations.record({
      email: "new@example.com",
      target: { type: "canvas", id: canvas.id },
      role: "viewer",
      invitedBy: owner.id,
    });
    const pending = (await svc.list(canvas)).find((e) => e.kind === "pending");
    expect(pending).toMatchObject({ role: "viewer", email: "new@example.com" });
    const id = (pending as { id: string }).id;
    expect(await svc.setRole(canvas, actor(owner, "owner"), id, "editor")).toEqual({ ok: true });
    expect((await svc.list(canvas)).find((e) => e.id === id)).toMatchObject({ role: "editor" });
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "allowlist_role_change",
        meta: expect.objectContaining({ kind: "pending", role: "editor", from: "viewer" }),
      }),
    );
    expect(await svc.remove(canvas, actor(owner, "owner"), id)).toEqual({ ok: true });
    expect((await svc.list(canvas)).find((e) => e.kind === "pending")).toBeUndefined();
    expect(await svc.remove(canvas, actor(owner, "owner"), id)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
  });
});

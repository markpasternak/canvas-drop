import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import { ownershipService } from "../canvas/ownership.js";
import type { DbClient } from "../db/factory.js";
import { allowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { seedPublishedCanvas } from "../db/repositories/gallery-test-helpers.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { kvRepository } from "../db/repositories/kv.js";
import { offboardingRepository } from "../db/repositories/offboarding.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { offboardingService } from "./offboarding.js";

const log = pino({ level: "silent" });
describe.each(DIALECTS)("offboarding [%s]", (dialect) => {
  let db: DbClient;
  afterEach(async () => {
    await db?.close();
  });
  async function setup() {
    db = await makeTestDb(dialect);
    const users = usersRepository(db);
    const seed = (name: string, isAdmin = false) =>
      users.upsert({ providerSub: name, email: `${name}@example.com`, name, isAdmin });
    const actor = await seed("admin", true);
    const leaving = await seed("leaving", true);
    const successor = await seed("successor");
    const canvases = canvasesRepository(db);
    const first = await seedPublishedCanvas(db, leaving.id);
    const second = await seedPublishedCanvas(db, leaving.id);
    const shared = await seedPublishedCanvas(db, successor.id);
    await canvases.setAccess(second, "public_link");
    await canvases.addAllowlistEntry({
      canvasId: shared,
      principalKind: "member",
      userId: leaving.id,
      role: "editor",
    });
    const teams = teamsRepository(db);
    const team = await teams.create({ orgId: null, name: "Shared team", createdBy: actor.id });
    await teams.addMember(team.id, leaving.id);
    const invitations = invitationsRepository(db);
    await invitations.record({
      email: leaving.email,
      target: { type: "canvas", id: shared },
      invitedBy: actor.id,
    });
    const allowedEmails = allowedEmailsRepository(db);
    await allowedEmails.add(leaving.email, actor.id);
    const audit = createAuditLog(auditRepository(db), log);
    const ownership = ownershipService({ canvases, users, audit, tenancyActive: false });
    const deps = {
      repository: offboardingRepository(db),
      users,
      canvases,
      teams,
      invitations,
      allowedEmails,
      ownership,
      revokeSessions: vi.fn(async () => {}),
      revokeMcpTokens: vi.fn(async () => {}),
      audit,
      log,
    };
    return {
      deps,
      actor,
      leaving,
      successor,
      first,
      second,
      shared,
      team,
      service: offboardingService(deps),
    };
  }

  it("reassigns owned canvases, removes grants/invites, revokes sessions and preserves content", async () => {
    const { deps, actor, leaving, successor, first, second, shared, team, service } = await setup();
    const oldKey = (await deps.canvases.findById(first))?.apiKeyHash;
    await kvRepository(db).set(first, "shared", "valuable", { keep: true }, leaving.id);
    const preview = await service.preview(leaving.email, actor.id, successor.id);
    expect(preview.owned).toHaveLength(2);
    expect(preview.owned.every((canvas) => canvas.transferEligible)).toBe(true);
    expect(preview.direct).toHaveLength(1);
    const result = await service.execute(
      {
        email: leaving.email,
        toUserId: successor.id,
        fingerprint: preview.fingerprint,
        reason: "Leaving the team",
        confirmation: `OFFBOARD ${leaving.email}`,
      },
      actor,
    );
    expect(result).toMatchObject({ complete: true, accountBlocked: true, unresolved: [] });
    expect(await deps.users.findById(leaving.id)).toMatchObject({
      isBlocked: true,
      isAdmin: false,
      canPublishPublic: false,
    });
    expect(deps.revokeSessions).toHaveBeenCalledWith(leaving.id);
    expect(deps.revokeMcpTokens).toHaveBeenCalledWith(leaving.id);
    for (const id of [first, second]) {
      expect(await deps.canvases.findById(id)).toMatchObject({
        ownerId: successor.id,
        status: "active",
      });
      expect(await deps.canvases.findMemberEntry(id, leaving.id)).toBeNull();
    }
    expect((await deps.canvases.findById(first))?.apiKeyHash).not.toBe(oldKey);
    expect((await deps.canvases.findById(second))?.access).toBe("public_link");
    expect(await kvRepository(db).find(first, "shared", "valuable")).toEqual({
      value: { keep: true },
    });
    expect(await deps.canvases.findMemberEntry(shared, leaving.id)).toBeNull();
    expect(await deps.teams.isTeamMember(team.id, leaving.id)).toBe(false);
    expect(await deps.invitations.listForEmail(leaving.email)).toEqual([]);
    expect(await deps.allowedEmails.isAllowed(leaving.email)).toBe(false);
    await deps.audit.flush();
    expect(
      (await auditRepository(db).recent()).find((e) => e.action === "user_offboard"),
    ).toMatchObject({ targetId: leaving.id, meta: { reassigned: 2, failed: 0 } });
  });

  it("rejects missing confirmation, self-offboarding and changed inventory before mutation", async () => {
    const { deps, actor, leaving, successor, service } = await setup();
    const preview = await service.preview(leaving.email, actor.id, successor.id);
    const input = {
      email: leaving.email,
      toUserId: successor.id,
      fingerprint: preview.fingerprint,
      reason: "Leaving",
      confirmation: `OFFBOARD ${leaving.email}`,
    };
    await expect(service.execute({ ...input, confirmation: "yes" }, actor)).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });
    await deps.teams.create({ orgId: null, name: "New membership", createdBy: leaving.id });
    await expect(service.execute(input, actor)).rejects.toMatchObject({ code: "CHANGED" });
    expect((await deps.users.findById(leaving.id))?.isBlocked).toBe(false);
    const own = await service.preview(actor.email, actor.id);
    await expect(
      service.execute(
        {
          email: actor.email,
          reason: "No",
          confirmation: `OFFBOARD ${actor.email}`,
          fingerprint: own.fingerprint,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "SELF" });
  });

  it("reports partial failures and unresolved ownership, then supports a fresh retry", async () => {
    const { deps, actor, leaving, successor } = await setup();
    deps.revokeSessions.mockRejectedValueOnce(new Error("temporary failure"));
    const service = offboardingService(deps);
    const first = await service.preview(leaving.email, actor.id);
    const result = await service.execute(
      {
        email: leaving.email,
        fingerprint: first.fingerprint,
        reason: "Leaving",
        confirmation: `OFFBOARD ${leaving.email}`,
      },
      actor,
    );
    expect(result.complete).toBe(false);
    expect(result.unresolved).toHaveLength(2);
    expect(
      result.outcomes.some((outcome) => outcome.kind === "sessions" && outcome.status === "failed"),
    ).toBe(true);
    expect(result.accountBlocked).toBe(true);
    const next = await service.preview(leaving.email, actor.id, successor.id);
    const retry = await service.execute(
      {
        email: leaving.email,
        toUserId: successor.id,
        fingerprint: next.fingerprint,
        reason: "Complete handover",
        confirmation: `OFFBOARD ${leaving.email}`,
      },
      actor,
    );
    expect(retry.complete).toBe(true);
  });

  it("removes pending-only permissions without inventing an account", async () => {
    const { deps, actor, shared, service } = await setup();
    const email = "pending@outside.test";
    await deps.invitations.record({
      email,
      target: { type: "canvas", id: shared },
      invitedBy: actor.id,
    });
    await deps.allowedEmails.add(email, actor.id);
    const preview = await service.preview(email, actor.id);
    expect(preview.user).toBeNull();
    expect(
      await service.execute(
        {
          email,
          fingerprint: preview.fingerprint,
          reason: "Invitation withdrawn",
          confirmation: `OFFBOARD ${email}`,
        },
        actor,
      ),
    ).toMatchObject({ complete: true, accountBlocked: null });
    expect(await deps.users.findByEmail(email)).toBeNull();
    expect(await deps.invitations.listForEmail(email)).toEqual([]);
  });

  it("serializes competing administrator offboarding so one usable admin survives", async () => {
    const { deps, actor, leaving } = await setup();
    const results = await Promise.all([
      deps.repository.blockAccount(actor.id, leaving.id),
      deps.repository.blockAccount(leaving.id, actor.id),
    ]);
    expect(results.filter((status) => status === "blocked")).toHaveLength(1);
    expect(await deps.users.countAdmins()).toBe(1);
    const survivor = (await deps.users.findById(actor.id))?.isBlocked ? leaving : actor;
    expect(await deps.repository.blockAccount(survivor.id, survivor.id)).toBe("self");
  });

  it("honors live recipient eligibility and reports grants added during cleanup", async () => {
    const { deps, actor, leaving, successor, shared } = await setup();
    const ownership = ownershipService({
      canvases: deps.canvases,
      users: deps.users,
      audit: deps.audit,
      tenancyActive: true,
      orgMembership: async () => new Set<string>(),
    });
    const pending = (await deps.invitations.listForEmail(leaving.email))[0];
    const service = offboardingService({
      ...deps,
      ownership,
      invitations: {
        ...deps.invitations,
        cancelPending: async (id: string) => {
          const result = await deps.invitations.cancelPending(id);
          await deps.canvases.addAllowlistEntry({
            canvasId: shared,
            principalKind: "member",
            userId: leaving.id,
            role: "viewer",
          });
          return result;
        },
      },
    });
    const preview = await service.preview(leaving.email, actor.id, successor.id);
    expect(preview.owned.every((canvas) => !canvas.transferEligible)).toBe(true);
    expect(preview.pending[0]?.id).toBe(pending?.id);
    const result = await service.execute(
      {
        email: leaving.email,
        toUserId: successor.id,
        fingerprint: preview.fingerprint,
        reason: "Leaving",
        confirmation: `OFFBOARD ${leaving.email}`,
      },
      actor,
    );
    expect(result.complete).toBe(false);
    expect(result.unresolved.some((item) => item.startsWith("Direct access:"))).toBe(true);
    expect(result.unresolved.filter((item) => item.startsWith("Ownership:"))).toHaveLength(2);
    expect((await deps.users.findById(leaving.id))?.isBlocked).toBe(true);
  });
});

import { type Config, loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import { materializePendingInvitations } from "../auth/invitations.js";
import type { DbClient } from "../db/factory.js";
import { allowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { emailTemplatesRepository } from "../db/repositories/email-templates.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { EmailMessage, Mailer, SendResult } from "../email/mailer.js";
import { seedDefaultTemplates } from "../email/templates.js";
import { inProcessRateLimitStore } from "../http/rate-limit.js";
import { type InviteActor, inviteService } from "./service.js";

const inert: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const org: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_ORG_NAME: "Acme",
  CANVAS_DROP_ORG_DOMAINS: "corp.com",
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "corp.com",
});

class FakeMailer implements Mailer {
  sent: EmailMessage[] = [];
  readonly canSend = true;
  async send(msg: EmailMessage): Promise<SendResult> {
    this.sent.push(msg);
    return { ok: true };
  }
}

/**
 * Roles on the Add person primitive (editor-roles plan U4, KTD2/KTD3/R21): the role
 * rides on grants and pending rows, an editor needs an org email under active tenancy,
 * add-with-role updates an existing row, and the courtesy emails name the role.
 */
describe.each(DIALECTS)("inviteService — roles [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function harness(cfg: Config) {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const orgs = orgsRepository(client);
    const invitations = invitationsRepository(client);
    const templates = emailTemplatesRepository(client);
    await seedDefaultTemplates(templates);
    if (cfg.org.name) await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["corp.com"] });
    const mailer = new FakeMailer();
    const svc = inviteService({
      config: cfg,
      users,
      allowedEmails: allowedEmailsRepository(client),
      invitations,
      teams: teamsRepository(client),
      canvases,
      orgs,
      settings: {
        effectiveInviteSettings: async () => ({
          emailEnabled: true,
          notifyOnAddUser: true,
          notifyOnCanvasAdd: true,
          notifyOnCanvasInvite: true,
          maxPerActorPerHour: 20,
          pendingCap: 50,
          allowMemberNewEmails: true,
        }),
        effectiveInstanceName: async () => "canvas-drop",
      },
      templates,
      mailer,
      rateLimitStore: inProcessRateLimitStore(),
    });
    const domain = cfg.org.name ? "corp.com" : "example.com";
    const owner = await users.upsert({
      providerSub: "owner",
      email: `owner@${domain}`,
      name: "Olive",
      isAdmin: false,
    });
    const colleague = await users.upsert({
      providerSub: "colleague",
      email: `colleague@${domain}`,
      name: "Cole",
      isAdmin: false,
    });
    const canvas = await canvases.create({ ownerId: owner.id, slug: "deck", apiKeyHash: "k" });
    const actor: InviteActor = { id: owner.id, name: "Olive", email: owner.email, isAdmin: false };
    const target = (role?: "viewer" | "editor", mode: "add" | "invite" = "add") =>
      ({
        kind: "canvas" as const,
        canvasId: canvas.id,
        canvasSlug: canvas.slug,
        canvasTitle: "Deck",
        mode,
        role,
      }) as const;
    return { users, canvases, invitations, mailer, svc, owner, colleague, canvas, actor, target };
  }

  it("grants an existing member with role editor; the courtesy email names the role", async () => {
    const { svc, canvases, mailer, colleague, canvas, actor, target } = await harness(inert);
    const r = await svc.resolveOrInvite(target("editor"), colleague.email, actor);
    expect(r).toMatchObject({ status: "granted", userId: colleague.id });
    expect((await canvases.findMemberEntry(canvas.id, colleague.id))?.role).toBe("editor");
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain("editor access to the canvas “Deck”");
    expect(mailer.sent[0]?.text).toContain("Olive");
  });

  it("add-with-role promotes an existing viewer in place (role_changed + email); a role-less re-add never demotes", async () => {
    const { svc, canvases, mailer, colleague, canvas, actor, target } = await harness(inert);
    expect((await svc.resolveOrInvite(target(), colleague.email, actor)).status).toBe("granted");
    expect(mailer.sent[0]?.text).toContain("view access");
    const promoted = await svc.resolveOrInvite(target("editor"), colleague.email, actor);
    expect(promoted).toMatchObject({ status: "role_changed", role: "editor", from: "viewer" });
    expect((await canvases.findMemberEntry(canvas.id, colleague.id))?.role).toBe("editor");
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1]?.text).toContain("editor access");
    expect((await svc.resolveOrInvite(target(), colleague.email, actor)).status).toBe(
      "already_added",
    );
    expect((await canvases.findMemberEntry(canvas.id, colleague.id))?.role).toBe("editor");
    // Same role again is the idempotent no-op.
    expect((await svc.resolveOrInvite(target("editor"), colleague.email, actor)).status).toBe(
      "already_added",
    );
  });

  it("AE15: under active tenancy an editor invite for a non-org email is refused GUEST_VIEWER_ONLY — nothing written, no email", async () => {
    const { svc, invitations, mailer, canvas, actor, target } = await harness(org);
    const r = await svc.resolveOrInvite(target("editor"), "someone@gmail.com", actor);
    expect(r).toEqual({ status: "guest_viewer_only" });
    expect(await invitations.listPendingForTarget("canvas", canvas.id)).toEqual([]);
    expect(mailer.sent).toEqual([]);
    expect(await svc.canHoldEditorRole("someone@gmail.com")).toBe(false);
    expect(await svc.canHoldEditorRole("someone@corp.com")).toBe(true);
  });

  it("AE15: an org-domain editor invite is recorded pending with role editor and materializes as an editor row", async () => {
    const { svc, users, canvases, invitations, canvas, actor, target } = await harness(org);
    const r = await svc.resolveOrInvite(target("editor"), "newbie@corp.com", actor);
    expect(r).toMatchObject({ status: "pending" });
    const [inv] = await invitations.listPendingForTarget("canvas", canvas.id);
    expect(inv).toMatchObject({ email: "newbie@corp.com", role: "editor" });
    const newbie = await users.upsert({
      providerSub: "newbie",
      email: "newbie@corp.com",
      name: "Newbie",
      isAdmin: false,
    });
    await materializePendingInvitations(
      { invitations, teams: teamsRepository(client), canvases },
      { id: newbie.id, email: newbie.email },
    );
    expect((await canvases.findMemberEntry(canvas.id, newbie.id))?.role).toBe("editor");
  });

  it("an existing member with a non-org email cannot be made editor under active tenancy (KD2)", async () => {
    const { svc, users, canvases, canvas, actor, target } = await harness(org);
    const outsider = await users.upsert({
      providerSub: "outsider",
      email: "outsider@gmail.com",
      name: "Out",
      isAdmin: false,
    });
    expect(await svc.resolveOrInvite(target("editor"), outsider.email, actor)).toEqual({
      status: "guest_viewer_only",
    });
    expect(await canvases.findMemberEntry(canvas.id, outsider.id)).toBeNull();
    // Inert tenancy: any member qualifies (KTD2).
    const h2 = await harness(inert);
    const out2 = await h2.users.upsert({
      providerSub: "outsider",
      email: "outsider@gmail.com",
      name: "Out",
      isAdmin: false,
    });
    expect((await h2.svc.resolveOrInvite(h2.target("editor"), out2.email, h2.actor)).status).toBe(
      "granted",
    );
  });

  it("notifyOwnerOfEditorGrant names the actor, the person, and the canvas (R21)", async () => {
    const { svc, mailer, owner, canvas } = await harness(inert);
    const r = await svc.notifyOwnerOfEditorGrant({
      canvasSlug: canvas.slug,
      canvasTitle: "Deck",
      ownerEmail: owner.email,
      personEmail: "colleague@example.com",
      actor: { id: "e1", name: "Edna", email: "edna@example.com", isAdmin: false },
    });
    expect(r).toEqual({ status: "sent" });
    expect(mailer.sent[0]?.to).toBe(owner.email);
    expect(mailer.sent[0]?.subject).toBe("Edna made colleague@example.com an editor of “Deck”");
    expect(mailer.sent[0]?.text).toContain("editor access to your canvas “Deck”");
  });
});

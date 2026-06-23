import { type Config, loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { allowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { emailTemplatesRepository } from "../db/repositories/email-templates.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { EmailMessage, Mailer, SendResult } from "../email/mailer.js";
import { seedDefaultTemplates } from "../email/templates.js";
import { inProcessRateLimitStore } from "../http/rate-limit.js";
import {
  type InviteActor,
  type InviteServiceDeps,
  type InviteTarget,
  inviteService,
} from "./service.js";

// Domain-allowlisted instance so we can exercise the "would authenticate anyway" branch.
const config: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "corp.com",
  CANVAS_DROP_OIDC_ISSUER: "https://idp.example",
  CANVAS_DROP_OIDC_CLIENT_ID: "cid",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(32),
  CANVAS_DROP_BASE_URL: "https://canvas.corp.com",
  CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE: "true",
});

const proxyConfig: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "proxy",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvas.corp.com",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(32),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "corp.com",
  CANVAS_DROP_TRUSTED_PROXY_IPS: "10.0.0.0/8",
});

const orgConfig: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "corp.com",
  CANVAS_DROP_ORG_NAME: "Acme",
  CANVAS_DROP_ORG_DOMAINS: "corp.com",
  CANVAS_DROP_OIDC_ISSUER: "https://idp.example",
  CANVAS_DROP_OIDC_CLIENT_ID: "cid",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(32),
  CANVAS_DROP_BASE_URL: "https://canvas.corp.com",
  CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE: "true",
});

class FakeMailer implements Mailer {
  sent: EmailMessage[] = [];
  constructor(readonly canSend = true) {}
  async send(msg: EmailMessage): Promise<SendResult> {
    this.sent.push(msg);
    return { ok: true };
  }
}

type Settings = Awaited<ReturnType<InviteServiceDeps["settings"]["effectiveInviteSettings"]>>;
const SETTINGS: Settings = {
  emailEnabled: true,
  notifyOnAddUser: true,
  notifyOnCanvasAdd: true,
  notifyOnCanvasInvite: true,
  maxPerActorPerHour: 20,
  pendingCap: 50,
  allowMemberNewEmails: false,
};

describe.each(DIALECTS)("inviteService.resolveOrInvite (plan 003 U5) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function harness(
    overrides: Partial<Settings> = {},
    cfg: Config = config,
    displayName = "canvas.corp.com",
  ) {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const allowedEmails = allowedEmailsRepository(client);
    const invitations = invitationsRepository(client);
    const teams = teamsRepository(client);
    const canvases = canvasesRepository(client);
    const templates = emailTemplatesRepository(client);
    await seedDefaultTemplates(templates);
    const mailer = new FakeMailer();
    const settings = { ...SETTINGS, ...overrides };

    const svc = inviteService({
      config: cfg,
      users,
      allowedEmails,
      invitations,
      teams,
      canvases,
      settings: {
        async effectiveInviteSettings() {
          return settings;
        },
        async effectiveInstanceName() {
          return displayName;
        },
      },
      templates,
      mailer,
      rateLimitStore: inProcessRateLimitStore(),
    });

    const owner = await users.upsert({
      providerSub: "oidc:owner",
      email: "owner@corp.com",
      name: "Owner",
      isAdmin: false,
    });
    const team = await teams.create({ orgId: null, name: "Crew", createdBy: owner.id });
    const adminUser = await users.upsert({
      providerSub: "oidc:admin",
      email: "admin@corp.com",
      name: "Admin",
      isAdmin: true,
    });
    const memberActor: InviteActor = {
      id: owner.id,
      name: "Owner",
      email: "owner@corp.com",
      isAdmin: false,
    };
    const adminActor: InviteActor = {
      id: adminUser.id,
      name: "Admin",
      email: "admin@corp.com",
      isAdmin: true,
    };
    const teamTarget: InviteTarget = { kind: "team", teamId: team.id, teamName: "Crew" };

    return {
      users,
      allowedEmails,
      invitations,
      teams,
      canvases,
      mailer,
      svc,
      owner,
      team,
      memberActor,
      adminActor,
      teamTarget,
    };
  }

  it("existing user → granted now; emails an existing user only when the per-event setting is on (team never)", async () => {
    const h = await harness();
    const existing = await h.users.upsert({
      providerSub: "oidc:x",
      email: "x@corp.com",
      name: "X",
      isAdmin: false,
    });
    const r = await h.svc.resolveOrInvite(h.teamTarget, "X@corp.com", h.memberActor);
    expect(r).toEqual({ status: "granted", userId: existing.id });
    expect(await h.teams.isTeamMember(h.team.id, existing.id)).toBe(true);
    // Team add NEVER notifies an existing member.
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("new email, admin actor → permit + pending invitation + courtesy email", async () => {
    const h = await harness();
    const r = await h.svc.resolveOrInvite(h.teamTarget, "newbie@external.io", h.adminActor);
    expect(r).toEqual({ status: "pending" });
    expect(await h.allowedEmails.isAllowed("newbie@external.io")).toBe(true);
    expect(await h.invitations.listForEmail("newbie@external.io")).toHaveLength(1);
    expect(h.mailer.sent.map((m) => m.to)).toEqual(["newbie@external.io"]);
  });

  it("new external email, self-serve actor, toggle OFF → rejected (no permit, no pending, no mail)", async () => {
    const h = await harness({ allowMemberNewEmails: false });
    const r = await h.svc.resolveOrInvite(h.teamTarget, "stranger@external.io", h.memberActor);
    expect(r).toEqual({ status: "policy_blocked", reason: "new_email_not_permitted" });
    expect(await h.allowedEmails.isAllowed("stranger@external.io")).toBe(false);
    expect(await h.invitations.listForEmail("stranger@external.io")).toHaveLength(0);
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("new external email, self-serve actor, toggle ON → pending + courtesy", async () => {
    const h = await harness({ allowMemberNewEmails: true });
    const r = await h.svc.resolveOrInvite(h.teamTarget, "friend@external.io", h.memberActor);
    expect(r).toEqual({ status: "pending" });
    expect(await h.allowedEmails.isAllowed("friend@external.io")).toBe(true);
    expect(await h.invitations.listForEmail("friend@external.io")).toHaveLength(1);
    expect(h.mailer.sent).toHaveLength(1);
  });

  it("new email that's domain-matched (authenticates anyway), self-serve → pending + courtesy, no new permit row", async () => {
    const h = await harness({ allowMemberNewEmails: false });
    const r = await h.svc.resolveOrInvite(h.teamTarget, "colleague@corp.com", h.memberActor);
    expect(r).toEqual({ status: "pending" });
    // Domain already authenticates → no allowlist row was added.
    expect(await h.allowedEmails.list()).toHaveLength(0);
    expect(await h.invitations.listForEmail("colleague@corp.com")).toHaveLength(1);
    expect(h.mailer.sent).toHaveLength(1);
  });

  it("already-member returns already_added; email lowercased/trimmed", async () => {
    const h = await harness();
    const existing = await h.users.upsert({
      providerSub: "oidc:dup",
      email: "dup@corp.com",
      name: "Dup",
      isAdmin: false,
    });
    const first = await h.svc.resolveOrInvite(h.teamTarget, "  DUP@corp.com  ", h.memberActor);
    const second = await h.svc.resolveOrInvite(h.teamTarget, "dup@corp.com", h.memberActor);
    expect(first).toEqual({ status: "granted", userId: existing.id });
    expect(second).toEqual({ status: "already_added", userId: existing.id });
    const members = (await h.teams.getMembers(h.team.id)).filter((m) => m.userId === existing.id);
    expect(members).toHaveLength(1);
  });

  it("already-pending invitation returns already_pending without duplicating or emailing again", async () => {
    const h = await harness();
    const first = await h.svc.resolveOrInvite(h.teamTarget, "pending@external.io", h.adminActor);
    const second = await h.svc.resolveOrInvite(h.teamTarget, "pending@external.io", h.adminActor);
    expect(first).toEqual({ status: "pending" });
    expect(second).toEqual({ status: "already_pending" });
    expect(await h.invitations.listForEmail("pending@external.io")).toHaveLength(1);
    expect(h.mailer.sent.map((m) => m.to)).toEqual(["pending@external.io"]);
  });

  it("blocked signed-in user returns blocked and is not granted", async () => {
    const h = await harness();
    const blocked = await h.users.upsert({
      providerSub: "oidc:blocked",
      email: "blocked@corp.com",
      name: "Blocked",
      isAdmin: false,
    });
    await h.users.setBlocked(blocked.id, true);
    const r = await h.svc.resolveOrInvite(h.teamTarget, "blocked@corp.com", h.adminActor);
    expect(r).toEqual({ status: "blocked", userId: blocked.id });
    expect(await h.teams.isTeamMember(h.team.id, blocked.id)).toBe(false);
  });

  it("proxy mode blocks brand-new external email without permit or pending grant", async () => {
    const h = await harness({ allowMemberNewEmails: true }, proxyConfig);
    const r = await h.svc.resolveOrInvite(h.teamTarget, "iap@external.io", h.adminActor);
    expect(r).toEqual({ status: "auth_admission_required" });
    expect(await h.allowedEmails.isAllowed("iap@external.io")).toBe(false);
    expect(await h.invitations.listForEmail("iap@external.io")).toHaveLength(0);
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("rate limit: over maxPerActorPerHour → rate_limited with nothing recorded/sent; admin bypasses", async () => {
    const h = await harness({ maxPerActorPerHour: 2, allowMemberNewEmails: true });
    const r1 = await h.svc.resolveOrInvite(h.teamTarget, "a@external.io", h.memberActor);
    const r2 = await h.svc.resolveOrInvite(h.teamTarget, "b@external.io", h.memberActor);
    const r3 = await h.svc.resolveOrInvite(h.teamTarget, "c@external.io", h.memberActor);
    expect(r1.status).toBe("pending");
    expect(r2.status).toBe("pending");
    expect(r3.status).toBe("rate_limited");
    // Nothing recorded/sent for the refused one.
    expect(await h.invitations.listForEmail("c@external.io")).toHaveLength(0);
    expect(await h.allowedEmails.isAllowed("c@external.io")).toBe(false);
    // Admin is not bound by the per-actor cap.
    const ra = await h.svc.resolveOrInvite(h.teamTarget, "d@external.io", h.adminActor);
    expect(ra.status).toBe("pending");
  });

  it("pending cap: beyond N un-consumed → rate_limited; admin bypasses the cap", async () => {
    const h = await harness({ pendingCap: 1, allowMemberNewEmails: true });
    const r1 = await h.svc.resolveOrInvite(h.teamTarget, "p1@external.io", h.memberActor);
    const r2 = await h.svc.resolveOrInvite(h.teamTarget, "p2@external.io", h.memberActor);
    expect(r1.status).toBe("pending");
    expect(r2.status).toBe("rate_limited");
    expect(await h.invitations.listForEmail("p2@external.io")).toHaveLength(0);
    // Admin bypasses the pending cap.
    const ra = await h.svc.resolveOrInvite(h.teamTarget, "p3@external.io", h.adminActor);
    expect(ra.status).toBe("pending");
  });

  it("master email toggle OFF → grant/pending still happen, but no email is sent", async () => {
    const h = await harness({ emailEnabled: false, allowMemberNewEmails: true });
    const r = await h.svc.resolveOrInvite(h.teamTarget, "silent@external.io", h.memberActor);
    expect(r.status).toBe("pending");
    expect(await h.invitations.listForEmail("silent@external.io")).toHaveLength(1);
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("canvas Specific-people add of an existing user notifies per notifyOnCanvasAdd", async () => {
    const h = await harness({ notifyOnCanvasAdd: false });
    const cv = await h.canvases.create({ ownerId: h.owner.id, slug: "deck-x", apiKeyHash: "k" });
    const existing = await h.users.upsert({
      providerSub: "oidc:cm",
      email: "cm@corp.com",
      name: "CM",
      isAdmin: false,
    });
    const target: InviteTarget = {
      kind: "canvas",
      canvasId: cv.id,
      canvasSlug: cv.slug,
      canvasTitle: "Deck",
      mode: "add",
    };
    const r = await h.svc.resolveOrInvite(target, "cm@corp.com", h.memberActor);
    expect(r).toEqual({ status: "granted", userId: existing.id });
    expect(await h.canvases.isPrincipalAllowed(cv.id, { userId: existing.id })).toBe(true);
    expect(h.mailer.sent).toHaveLength(0); // toggle off
  });

  it("external canvas invite copy names the canvas, not the org", async () => {
    const h = await harness({ allowMemberNewEmails: true }, orgConfig, "Canvas Drop Internal");
    const cv = await h.canvases.create({ ownerId: h.owner.id, slug: "deck-copy", apiKeyHash: "k" });
    const target: InviteTarget = {
      kind: "canvas",
      canvasId: cv.id,
      canvasSlug: cv.slug,
      canvasTitle: "Board Review",
      mode: "invite",
    };

    const r = await h.svc.resolveOrInvite(target, "friend@external.io", h.memberActor);
    expect(r.status).toBe("pending");
    expect(h.mailer.sent).toHaveLength(1);
    expect(h.mailer.sent[0]?.text).toContain("access to the canvas “Board Review”");
    expect(h.mailer.sent[0]?.text).toContain("friend@external.io");
    expect(h.mailer.sent[0]?.text).not.toContain("Canvas Drop Internal");
    expect(h.mailer.sent[0]?.text).not.toContain("Acme");
  });

  it("account invite copy does not depend on instance or org names", async () => {
    const h = await harness({}, orgConfig, "Canvas Drop Internal");
    const target: InviteTarget = { kind: "account" };

    await h.svc.resolveOrInvite(target, "colleague@corp.com", h.adminActor);
    await h.svc.resolveOrInvite(target, "contractor@external.io", h.adminActor);

    expect(h.mailer.sent).toHaveLength(2);
    expect(h.mailer.sent[0]?.text).toContain("invited colleague@corp.com to sign in");
    expect(h.mailer.sent[0]?.text).not.toContain("Canvas Drop Internal");
    expect(h.mailer.sent[0]?.text).not.toContain("Acme");
    expect(h.mailer.sent[1]?.text).toContain("invited contractor@external.io to sign in");
    expect(h.mailer.sent[1]?.text).not.toContain("Canvas Drop Internal");
    expect(h.mailer.sent[1]?.text).not.toContain("Acme");
  });
});

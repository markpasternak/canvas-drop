import { type Config, loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { allowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { guestRepository } from "../db/repositories/guest.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { hashToken } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { runLegacyGuestCutover } from "./legacy-guest-cutover.js";

const appConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "corp.com",
  CANVAS_DROP_OIDC_ISSUER: "https://idp.example",
  CANVAS_DROP_OIDC_CLIENT_ID: "cid",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(32),
  CANVAS_DROP_BASE_URL: "https://canvas.corp.com",
  CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE: "true",
});

const proxyConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "proxy",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvas.corp.com",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(32),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "corp.com",
  CANVAS_DROP_TRUSTED_PROXY_IPS: "10.0.0.0/8",
});

async function seed(
  client: DbClient,
  guestEmail: string,
  opts: {
    inviteExpiresAt?: number | null;
    sessionExpiresAt?: number;
    createSession?: boolean;
  } = {},
) {
  const users = usersRepository(client);
  const canvases = canvasesRepository(client);
  const guests = guestRepository(client);
  const owner = await users.upsert({
    providerSub: "owner",
    email: "owner@corp.com",
    name: "Owner",
    isAdmin: false,
  });
  const slug = `s-${guestEmail.replace(/[^a-z0-9]+/gi, "-").replace(/-$/g, "")}`;
  const cv = await canvases.create({ ownerId: owner.id, slug, apiKeyHash: "h" });
  const guestEntry = await canvases.addAllowlistEntry({
    canvasId: cv.id,
    principalKind: "guest",
    email: guestEmail,
  });
  const invite = await guests.createInvite({
    canvasId: cv.id,
    email: guestEmail,
    tokenHash: hashToken(`invite-${guestEmail}`),
    expiresAt: opts.inviteExpiresAt ?? null,
  });
  const sessionToken = `session-${guestEmail}`;
  if (opts.createSession !== false) {
    await guests.createSession({
      inviteId: invite.id,
      canvasId: cv.id,
      tokenHash: hashToken(sessionToken),
      expiresAt: opts.sessionExpiresAt ?? Date.now() + 60_000,
    });
  }
  return { owner, cv, guestEntry, invite, sessionToken };
}

function cutoverDeps(client: DbClient, config: Config) {
  return {
    config,
    users: usersRepository(client),
    allowedEmails: allowedEmailsRepository(client),
    invitations: invitationsRepository(client),
    canvases: canvasesRepository(client),
    guests: guestRepository(client),
  };
}

describe.each(DIALECTS)("runLegacyGuestCutover [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("converts a legacy guest matching an existing user into a member allowlist row", async () => {
    client = await makeTestDb(dialect);
    const { cv, guestEntry, sessionToken } = await seed(client, "friend@corp.com");
    const users = usersRepository(client);
    const member = await users.upsert({
      providerSub: "friend",
      email: "friend@corp.com",
      name: "Friend",
      isAdmin: false,
    });

    const report = await runLegacyGuestCutover(cutoverDeps(client, appConfig));
    expect(report).toMatchObject({
      considered: 1,
      convertedToMembers: 1,
      convertedToPending: 0,
      removedGuestAllowlistRows: 1,
      revokedCredentials: true,
    });

    const canvases = canvasesRepository(client);
    expect(await canvases.isPrincipalAllowed(cv.id, { userId: member.id })).toBe(true);
    expect((await canvases.listAllowlist(cv.id)).some((e) => e.id === guestEntry.id)).toBe(false);
    expect(await guestRepository(client).findLiveSessionByTokenHash(hashToken(sessionToken))).toBe(
      null,
    );

    const again = await runLegacyGuestCutover(cutoverDeps(client, appConfig));
    expect(again.considered).toBe(0);
    const memberRows = (await canvases.listAllowlist(cv.id)).filter((e) => e.userId === member.id);
    expect(memberRows).toHaveLength(1);
  });

  it("converts an unmatched app-managed guest into a pending canvas grant and sign-in permit", async () => {
    client = await makeTestDb(dialect);
    const { cv } = await seed(client, "external@example.net");

    const report = await runLegacyGuestCutover(cutoverDeps(client, appConfig));
    expect(report).toMatchObject({
      considered: 1,
      convertedToMembers: 0,
      convertedToPending: 1,
      permitsAdded: 1,
      removedGuestAllowlistRows: 1,
      revokedCredentials: true,
    });
    expect(await allowedEmailsRepository(client).isAllowed("external@example.net")).toBe(true);
    const pending = await invitationsRepository(client).listForEmail("external@example.net");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ targetType: "canvas", targetId: cv.id });
  });

  it("reports proxy-inadmissible legacy guests without creating unreachable pending access", async () => {
    client = await makeTestDb(dialect);
    const { cv, guestEntry, sessionToken } = await seed(client, "external@example.net");

    const report = await runLegacyGuestCutover(cutoverDeps(client, proxyConfig));
    expect(report.convertedToPending).toBe(0);
    expect(report.manualActionRequired).toEqual([
      { canvasId: cv.id, email: "external@example.net", reason: "proxy_admission_required" },
    ]);
    expect(await allowedEmailsRepository(client).isAllowed("external@example.net")).toBe(false);
    expect(await invitationsRepository(client).listForEmail("external@example.net")).toHaveLength(
      0,
    );
    const allowlist = await canvasesRepository(client).listAllowlist(cv.id);
    expect(allowlist.some((e) => e.id === guestEntry.id)).toBe(true);
    expect(await guestRepository(client).findLiveSessionByTokenHash(hashToken(sessionToken))).toBe(
      null,
    );
  });

  it("does not revive an expired pending invite, even if a guest allowlist row remains", async () => {
    client = await makeTestDb(dialect);
    const { cv, guestEntry } = await seed(client, "expired@example.net", {
      inviteExpiresAt: Date.now() - 1_000,
      createSession: false,
    });

    const report = await runLegacyGuestCutover(cutoverDeps(client, appConfig));
    expect(report).toMatchObject({
      considered: 0,
      convertedToMembers: 0,
      convertedToPending: 0,
      permitsAdded: 0,
      removedGuestAllowlistRows: 0,
      revokedCredentials: true,
    });
    expect(await allowedEmailsRepository(client).isAllowed("expired@example.net")).toBe(false);
    expect(await invitationsRepository(client).listForEmail("expired@example.net")).toHaveLength(0);
    const allowlist = await canvasesRepository(client).listAllowlist(cv.id);
    expect(allowlist.some((e) => e.id === guestEntry.id)).toBe(true);
  });

  it("does not revive an active invite whose retained guest session has expired", async () => {
    client = await makeTestDb(dialect);
    const { cv, invite, guestEntry } = await seed(client, "friend@corp.com", {
      sessionExpiresAt: Date.now() - 1_000,
    });
    const guests = guestRepository(client);
    await guests.markConsumed(invite.id);
    const member = await usersRepository(client).upsert({
      providerSub: "friend",
      email: "friend@corp.com",
      name: "Friend",
      isAdmin: false,
    });

    const report = await runLegacyGuestCutover(cutoverDeps(client, appConfig));
    expect(report).toMatchObject({
      considered: 0,
      convertedToMembers: 0,
      convertedToPending: 0,
      removedGuestAllowlistRows: 0,
      revokedCredentials: true,
    });
    const canvases = canvasesRepository(client);
    expect(await canvases.isPrincipalAllowed(cv.id, { userId: member.id })).toBe(false);
    expect((await canvases.listAllowlist(cv.id)).some((e) => e.id === guestEntry.id)).toBe(true);
  });

  it("removes a newly-added sign-in permit if pending grant creation fails", async () => {
    client = await makeTestDb(dialect);
    await seed(client, "external@example.net");
    const deps = cutoverDeps(client, appConfig);

    await expect(
      runLegacyGuestCutover({
        ...deps,
        invitations: {
          record: async () => {
            throw new Error("record failed");
          },
        },
      }),
    ).rejects.toThrow("record failed");
    expect(await allowedEmailsRepository(client).isAllowed("external@example.net")).toBe(false);
    expect(await invitationsRepository(client).listForEmail("external@example.net")).toHaveLength(
      0,
    );
  });
});

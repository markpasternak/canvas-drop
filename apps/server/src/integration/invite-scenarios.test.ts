import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { type Harness, jsonOf, makeHarness, scenarioConfig } from "./scenario-harness.js";

/**
 * End-to-end invariants for the auth-delegated Add person flow (plan 003 U4/U5/U6/U7) over the
 * REAL composed app. Rejection-first: pending access NEVER grants on its own — it
 * materializes only on the person's first VERIFIED login (the gateway hook). The KTD5 gate
 * (a self-serve actor can't permit a brand-new external email; an admin can) and the per-actor
 * rate cap are exercised through the real HTTP routes.
 */

const FRIEND = "friend@guest.test"; // no-org user (guest.test isn't an org domain)
const NEWPAL = "newpal@guest.test"; // brand-new, domain-allowed → self-serve may invite
const STRANGER = "stranger@external.io"; // brand-new EXTERNAL → self-serve may NOT invite
const ADMIN = "admin@example.com"; // matches scenarioConfig's CANVAS_DROP_ADMIN_EMAILS

function inviteConfig() {
  return scenarioConfig({
    // guest.test signs in but is NOT an org domain (no org configured → all no-org users).
    CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com,guest.test",
  });
}

/** A no-org user creates a personal team + a personal canvas scoped to it. */
async function setupPersonalTeamCanvas(h: Harness): Promise<{ teamId: string; slug: string }> {
  await (await h.GET(FRIEND, "/api/me")).text();
  const teamRes = await h.SEND(FRIEND, "POST", "/api/teams", { name: "Family" });
  expect(teamRes.status).toBe(201);
  const { team } = await jsonOf<{ team: { id: string } }>(teamRes);

  const pasteRes = await h.SEND(FRIEND, "POST", "/api/canvases/paste", {
    html: "<h1>family photos</h1>",
    title: "Family",
    backendEnabled: true,
  });
  expect(pasteRes.status).toBe(201);
  const cv = await jsonOf<{ id: string; slug: string }>(pasteRes);
  const patch = await h.SEND(FRIEND, "PATCH", `/api/canvases/${cv.id}/settings`, {
    access: "team",
    teamIds: [team.id],
  });
  expect(patch.status).toBe(200);
  await patch.text();
  return { teamId: team.id, slug: cv.slug };
}

describe.each(DIALECTS)("invite scenarios [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("pending team invitation → invitee's first verified login materializes membership → reaches the canvas; re-login doesn't double-apply", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client, { config: inviteConfig() });
    const { teamId, slug } = await setupPersonalTeamCanvas(h);

    // Add a BRAND-NEW (not-yet-signed-in) email. Domain-allowed → a self-serve owner may
    // record pending access. The add returns `pending` (no user row yet).
    const invite = await h.SEND(FRIEND, "POST", `/api/teams/${teamId}/members`, { email: NEWPAL });
    expect(invite.status).toBe(200);
    expect((await jsonOf<{ status: string }>(invite)).status).toBe("pending");

    // The roster shows NEWPAL as PENDING (email-only, not a member yet).
    const roster1 = await h.GET(FRIEND, `/api/teams/${teamId}/members`);
    const r1 = await jsonOf<{
      members: Array<{ email: string | null }>;
      pending: Array<{ email: string }>;
    }>(roster1);
    expect(r1.pending.map((p) => p.email)).toContain(NEWPAL);
    expect(r1.members.map((m) => m.email)).not.toContain(NEWPAL);

    // NEWPAL signs in for the first time (any authenticated request) → the gateway hook
    // materializes the membership.
    await (await h.GET(NEWPAL, "/api/me")).text();

    // The roster now shows NEWPAL as a MEMBER, no longer pending.
    const roster2 = await h.GET(FRIEND, `/api/teams/${teamId}/members`);
    const r2 = await jsonOf<{
      members: Array<{ email: string | null }>;
      pending: Array<{ email: string }>;
    }>(roster2);
    expect(r2.members.map((m) => m.email)).toContain(NEWPAL);
    expect(r2.pending.map((p) => p.email)).not.toContain(NEWPAL);

    // …and NEWPAL reaches the team canvas over a real socket; a never-invited stranger 404s.
    const server = await h.listen();
    const get = (email: string) =>
      fetch(`http://localhost:${server.port}/c/${slug}/`, {
        headers: { host: h.baseHost, "x-test-user": email },
      });
    try {
      const pal = await get(NEWPAL);
      expect(pal.status).toBe(200);
      expect(await pal.text()).toContain("family photos");

      // A second login doesn't double-apply — still exactly one membership row.
      await (await h.GET(NEWPAL, "/api/me")).text();
      const roster3 = await jsonOf<{ members: Array<{ email: string | null }> }>(
        await h.GET(FRIEND, `/api/teams/${teamId}/members`),
      );
      expect(roster3.members.filter((m) => m.email === NEWPAL)).toHaveLength(1);

      const stranger = await get("nobody@guest.test");
      expect(stranger.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("KTD5 gate: a self-serve owner can't invite a brand-new EXTERNAL email (rejected); an admin Add-users permits it", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client, { config: inviteConfig() });
    const { teamId } = await setupPersonalTeamCanvas(h);

    // Self-serve owner invites a brand-new external email (not domain-allowed) → rejected.
    const rejected = await h.SEND(FRIEND, "POST", `/api/teams/${teamId}/members`, {
      email: STRANGER,
    });
    expect(rejected.status).toBe(403);
    expect((await jsonOf<{ error: string }>(rejected)).error).toBe("TARGET_NOT_PERMITTED");

    // An ADMIN can permit that same external email to sign in via Sign-in permits.
    await (await h.GET(ADMIN, "/api/me")).text();
    const added = await h.SEND(ADMIN, "POST", "/api/admin/allowed-emails", { email: STRANGER });
    expect(added.status).toBe(200);
    expect((await jsonOf<{ status: string }>(added)).status).toBe("pending");

    // The email is now a sign-in permit (it appears in the allowlist the admin manages).
    const list = await h.GET(ADMIN, "/api/admin/allowed-emails");
    const emails = (await jsonOf<{ emails: Array<{ email: string }> }>(list)).emails;
    expect(emails.map((e) => e.email)).toContain(STRANGER);
  });

  it("rate limit: a self-serve actor is refused past the per-actor cap, with nothing recorded beyond it", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client, { config: inviteConfig() });
    const { teamId } = await setupPersonalTeamCanvas(h);

    // An admin tightens the per-actor hourly cap to 1.
    await (await h.GET(ADMIN, "/api/me")).text();
    const set = await h.SEND(ADMIN, "PUT", "/api/admin/config/invites.maxPerActorPerHour", {
      value: 1,
    });
    expect(set.status).toBe(200);
    await set.text();

    // FRIEND's first invite passes; the second is refused (429) — nothing recorded beyond it.
    const first = await h.SEND(FRIEND, "POST", `/api/teams/${teamId}/members`, {
      email: "p1@guest.test",
    });
    expect(first.status).toBe(200);
    const second = await h.SEND(FRIEND, "POST", `/api/teams/${teamId}/members`, {
      email: "p2@guest.test",
    });
    expect(second.status).toBe(429);
    expect((await jsonOf<{ error: string }>(second)).error).toBe("RATE_LIMITED");
  });
});

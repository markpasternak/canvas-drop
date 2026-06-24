import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { type Harness, jsonOf, makeHarness, scenarioConfig } from "./scenario-harness.js";

/**
 * End-to-end invariants for the `team` access rung (plan 003 U8) over the REAL composed
 * app — the full gateway → orgIds → canvasAccess → decideCanvasAccess (+ the runtime-API
 * and clone seams). Rejection-first: a team canvas serves to a team member, and is
 * OPAQUELY 404 to a same-org non-member and a guest. The headline invariant is the KTD3
 * live-org re-join: an org-revoked member is denied even with a lingering `team_members`
 * row (a stale row can never widen access).
 */

const OWNER = "owner@example.com"; // Acme member (example.com); team creator + canvas owner
const MATE = "mate@contractor.test"; // Acme member (contractor.test domain); on the team
const NONMEMBER = "other@example.com"; // Acme member, NOT on the team
const GUEST = "g@guest.test"; // signs in, but in no org

function teamConfig() {
  return scenarioConfig({
    CANVAS_DROP_ORG_NAME: "Acme",
    // contractor.test is BOTH an allowed sign-in domain AND an Acme org domain (below), so
    // a contractor is a full Acme member — until the operator drops the domain.
    CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com,contractor.test,guest.test",
  });
}

/** Materialize Acme with two member domains (the harness doesn't run boot materialize). */
async function seedAcme(client: DbClient): Promise<string> {
  const org = await orgsRepository(client).ensureOrg({
    name: "Acme",
    slug: "acme",
    domains: ["example.com", "contractor.test"],
  });
  return org.id;
}

/** Owner creates a team, adds MATE, publishes a backend-on canvas, scopes it to the team. */
async function setupTeamCanvas(
  h: Harness,
  acmeId: string,
): Promise<{ teamId: string; canvasId: string; slug: string }> {
  // Each participant signs in once so the gateway materializes their org membership (a
  // prerequisite for add_team_member's same-org check + for clone/serve membership).
  for (const who of [OWNER, MATE, NONMEMBER]) await (await h.GET(who, "/api/me")).text();

  const teamRes = await h.SEND(OWNER, "POST", "/api/teams", { orgId: acmeId, name: "Design" });
  expect(teamRes.status).toBe(201);
  const { team } = await jsonOf<{ team: { id: string } }>(teamRes);

  const addRes = await h.SEND(OWNER, "POST", `/api/teams/${team.id}/members`, { email: MATE });
  expect(addRes.status).toBe(200);
  await addRes.text();

  const pasteRes = await h.SEND(OWNER, "POST", "/api/canvases/paste", {
    html: "<h1>team secret</h1>",
    title: "Team doc",
    backendEnabled: true,
  });
  expect(pasteRes.status).toBe(201);
  const cv = await jsonOf<{ id: string; slug: string }>(pasteRes);

  const patch = await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, {
    access: "team",
    teamIds: [team.id],
  });
  expect(patch.status).toBe(200);
  await patch.text();

  return { teamId: team.id, canvasId: cv.id, slug: cv.slug };
}

describe.each(DIALECTS)("team scenarios [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("serves a team canvas to team members; opaque 404 to a non-member and a guest", async () => {
    client = await makeTestDb(dialect);
    const acmeId = await seedAcme(client);
    const h = makeHarness(client, { config: teamConfig() });
    const { slug } = await setupTeamCanvas(h, acmeId);

    // Driven over a REAL socket so each request is fully independent (the serve seam's
    // authoritative end-to-end check).
    const server = await h.listen();
    const get = (email: string) =>
      fetch(`http://localhost:${server.port}/c/${slug}/`, {
        headers: { host: h.baseHost, "x-test-user": email },
      });
    try {
      // The owner and the granted teammate reach the content.
      for (const who of [OWNER, MATE]) {
        const res = await get(who);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("team secret");
      }
      // A same-org NON-member and a guest get the opaque not_found, never the content.
      for (const who of [NONMEMBER, GUEST]) {
        const res = await get(who);
        const body = await res.text();
        expect(res.status).toBe(404);
        expect(body).not.toContain("team secret");
      }
    } finally {
      await server.close();
    }
  });

  it("runtime API (me) honors the team rung — member resolves, non-member 404s", async () => {
    client = await makeTestDb(dialect);
    const acmeId = await seedAcme(client);
    const h = makeHarness(client, { config: teamConfig() });
    const { slug } = await setupTeamCanvas(h, acmeId);

    // A team member resolves identity through the runtime seam (canvas-api teamMatch).
    const mate = await h.GET(MATE, `/v1/c/${slug}/me`);
    expect(mate.status).toBe(200);
    expect((await jsonOf<{ kind: string }>(mate)).kind).toBe("member");

    // A same-org non-member is denied at the runtime seam too (opaque).
    const other = await h.GET(NONMEMBER, `/v1/c/${slug}/me`);
    expect(other.status).toBe(404);
    await other.text();
  });

  it("personal team (plan 003 U6): a no-org user shares a personal canvas with a personal team; members reach it, a stranger 404s", async () => {
    client = await makeTestDb(dialect);
    // No org needed — guest.test isn't an Acme domain, so these users are all no-org.
    const h = makeHarness(client, { config: teamConfig() });

    const FRIEND = "friend@guest.test"; // no org (guest.test isn't an Acme domain)
    const PAL = "pal@guest.test"; // no org; an existing user FRIEND invites
    const STRANGER = "stranger@guest.test"; // no org; never on the team
    for (const who of [FRIEND, PAL, STRANGER]) await (await h.GET(who, "/api/me")).text();

    // A no-org user creates a PERSONAL team (no orgId in the body).
    const teamRes = await h.SEND(FRIEND, "POST", "/api/teams", { name: "Family" });
    expect(teamRes.status).toBe(201);
    const { team } = await jsonOf<{ team: { id: string; orgId: string | null } }>(teamRes);
    expect(team.orgId).toBeNull();

    // Invite PAL (an existing user) → granted immediately (no org-membership requirement).
    const addRes = await h.SEND(FRIEND, "POST", `/api/teams/${team.id}/members`, { email: PAL });
    expect(addRes.status).toBe(200);
    expect((await jsonOf<{ status: string }>(addRes)).status).toBe("granted");

    // FRIEND publishes a PERSONAL canvas (org_id null) and scopes it to the personal team —
    // this must NOT trip a TEAM_REQUIRED/home-org guard (KTD: personal teams need no org).
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

    // Serve over a real socket: FRIEND (owner) + PAL (member) reach it; STRANGER is opaque 404.
    const server = await h.listen();
    const get = (email: string) =>
      fetch(`http://localhost:${server.port}/c/${cv.slug}/`, {
        headers: { host: h.baseHost, "x-test-user": email },
      });
    try {
      for (const who of [FRIEND, PAL]) {
        const res = await get(who);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("family photos");
      }
      const stranger = await get(STRANGER);
      expect(stranger.status).toBe(404);
      expect(await stranger.text()).not.toContain("family photos");
    } finally {
      await server.close();
    }
  });

  it("KTD3 live re-join: an org-revoked member is denied even with a lingering team row", async () => {
    client = await makeTestDb(dialect);
    const acmeId = await seedAcme(client);
    const h = makeHarness(client, { config: teamConfig() });
    const { teamId, slug } = await setupTeamCanvas(h, acmeId);

    // Baseline: the teammate currently reaches the canvas.
    expect(await (await h.GET(MATE, `/c/${slug}/`)).text()).toContain("team secret");

    // The operator removes the contractor.test domain (re-ensure Acme with only
    // example.com → the gateway no longer DERIVES Acme for the contractor) and revokes the
    // explicit membership — but we DON'T reconcile, so the `team_members` row LINGERS.
    const mate = await usersRepository(client).findByEmail(MATE);
    if (!mate) throw new Error("seed: mate user missing");
    await orgsRepository(client).ensureOrg({
      name: "Acme",
      slug: "acme",
      domains: ["example.com"],
    });
    await orgMembersRepository(client).remove(acmeId, mate.id);

    // The lingering team membership row still exists — proving the denial below is the
    // live-org re-join, not row cleanup.
    expect(await teamsRepository(client).isTeamMember(teamId, mate.id)).toBe(true);

    // Now an outsider: orgIds is empty, so the teamMatch re-join fails → opaque 404, even
    // though the stale team row says they're on the team.
    const denied = await h.GET(MATE, `/c/${slug}/`);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("team secret");
  });

  it("Shared lists only discoverable team canvases for a member, excluding owner and non-member", async () => {
    client = await makeTestDb(dialect);
    const acmeId = await seedAcme(client);
    const h = makeHarness(client, { config: teamConfig() });
    const { canvasId } = await setupTeamCanvas(h, acmeId);

    const idsFor = async (email: string) =>
      (
        await jsonOf<{ canvases: Array<{ id: string }> }>(
          await h.GET(email, "/api/canvases/shared"),
        )
      ).canvases.map((c) => c.id);

    // URL access works for the team member, but Shared is still opt-in.
    expect(await idsFor(MATE)).not.toContain(canvasId);
    const listed = await h.SEND(OWNER, "PATCH", `/api/canvases/${canvasId}/settings`, {
      discoverability: "listed",
    });
    expect(listed.status).toBe(200);
    await listed.text();

    // The teammate sees it; the owner does NOT (it's their own); a non-member doesn't either.
    expect(await idsFor(MATE)).toContain(canvasId);
    expect(await idsFor(OWNER)).not.toContain(canvasId);
    expect(await idsFor(NONMEMBER)).not.toContain(canvasId);
  });

  it("clone seam: a team member may clone a team canvas; a non-member cannot", async () => {
    client = await makeTestDb(dialect);
    const acmeId = await seedAcme(client);
    const h = makeHarness(client, { config: teamConfig() });
    const { canvasId } = await setupTeamCanvas(h, acmeId);

    const mateClone = await h.SEND(MATE, "POST", `/api/canvases/${canvasId}/clone`);
    expect(mateClone.status).toBe(201);
    await mateClone.text();

    const otherClone = await h.SEND(NONMEMBER, "POST", `/api/canvases/${canvasId}/clone`);
    expect(otherClone.status).toBe(404);
    await otherClone.text();
  });

  it("PERSONAL team: a no-org member reaches a personal-canvas team share; a non-member 404s", async () => {
    // plan 003 phase 3 — the headline new invariant. A PERSONAL team (org_id null) granted to
    // a PERSONAL canvas (org_id null) is reachable by its direct members regardless of org —
    // including a guest with no org — and opaque to everyone else, end-to-end over the serve seam.
    client = await makeTestDb(dialect);
    await seedAcme(client);
    const h = makeHarness(client, { config: teamConfig() });

    // Materialize the participants (first request creates the user; GUEST is a no-org user).
    for (const who of [OWNER, GUEST, NONMEMBER]) await (await h.GET(who, "/api/me")).text();
    const users = usersRepository(client);
    const ownerU = await users.findByEmail(OWNER);
    const guestU = await users.findByEmail(GUEST);
    if (!ownerU || !guestU) throw new Error("seed: users missing");

    // Seed a PERSONAL team owned by OWNER (the route doesn't expose personal creation until a
    // later unit, so seed via the repo) with the no-org GUEST as a member.
    const teams = teamsRepository(client);
    const team = await teams.create({ orgId: null, name: "Friends", createdBy: ownerU.id });
    await teams.addMember(team.id, guestU.id);

    // OWNER publishes a PERSONAL canvas (org_id null) and shares it with the personal team.
    const paste = await h.SEND(OWNER, "POST", "/api/canvases/paste", {
      html: "<h1>family photos</h1>",
      title: "Family",
      orgId: null,
      backendEnabled: true,
    });
    expect(paste.status).toBe(201);
    const cv = await jsonOf<{ id: string; slug: string }>(paste);
    const patch = await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, {
      access: "team",
      teamIds: [team.id],
    });
    expect(patch.status).toBe(200);
    await patch.text();

    const server = await h.listen();
    const get = (email: string) =>
      fetch(`http://localhost:${server.port}/c/${cv.slug}/`, {
        headers: { host: h.baseHost, "x-test-user": email },
      });
    try {
      // The no-org GUEST member reaches it (personal teams ignore org membership).
      const ok = await get(GUEST);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("family photos");
      // A non-member is opaque 404.
      const denied = await get(NONMEMBER);
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain("family photos");
    } finally {
      await server.close();
    }
  });
});

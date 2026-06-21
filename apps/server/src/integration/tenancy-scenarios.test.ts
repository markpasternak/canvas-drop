import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { type Harness, jsonOf, makeHarness, scenarioConfig } from "./scenario-harness.js";

/**
 * End-to-end tenancy invariants (plan 002 U9) over the REAL composed app — the full
 * gateway → orgIds → requestPrincipal → canvasAccess → decideCanvasAccess wiring, not a
 * unit seam. Rejection-first: a whole_org canvas is reachable by a same-org member and
 * OPAQUELY 404 to a cross-org member and a guest.
 */

const ACME = "member@example.com"; // owner, Acme (example.com)
const ACME_OTHER = "other@example.com"; // another Acme member
const BETA = "beta@partner.test"; // a member of a DIFFERENT org
const GUEST = "g@guest.test"; // signs in, but in no org

/** GET a canvas path and return its body text. We assert on the BODY rather than the
 *  status: the in-process app (hono `app.request`) can report a stale `.status` on a
 *  streamed response read out of order, but the body is always the real one. A denied
 *  canvas serves the opaque `{"error":"not_found"}`; an allowed one serves its content. */
async function getBody(h: Harness, email: string | null, path: string): Promise<string> {
  return (await h.GET(email, path)).text();
}

function tenancyConfig() {
  return scenarioConfig({
    CANVAS_DROP_ORG_NAME: "Acme",
    CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com,partner.test,guest.test",
  });
}

/** Materialize two orgs directly (the harness doesn't run the boot materialize step). */
async function seedOrgs(client: DbClient) {
  const orgs = orgsRepository(client);
  await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["example.com"] });
  await orgs.ensureOrg({ name: "Beta", slug: "beta", domains: ["partner.test"] });
}

/** Paste-publish a canvas as `owner`, set it to `whole_org`, return its slug. */
async function publishWholeOrg(h: Harness, owner: string): Promise<string> {
  const res = await h.SEND(owner, "POST", "/api/canvases/paste", {
    html: "<h1>org secret</h1>",
    title: "Org doc",
  });
  expect(res.status).toBe(201);
  const cv = await jsonOf<{ id: string; slug: string }>(res);
  const patch = await h.SEND(owner, "PATCH", `/api/canvases/${cv.id}/settings`, {
    access: "whole_org",
  });
  expect(patch.status).toBe(200);
  await patch.text(); // drain — an undrained body leaks into the next in-process request
  return cv.slug;
}

describe.each(DIALECTS)("tenancy scenarios [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("active tenancy: a whole_org canvas serves to same-org members and is opaque to outsiders", async () => {
    // Driven over a REAL HTTP socket (not the in-process app) so each request is fully
    // independent — the authoritative end-to-end check of the serve seam.
    client = await makeTestDb(dialect);
    await seedOrgs(client);
    const h = makeHarness(client, { config: tenancyConfig() });
    const slug = await publishWholeOrg(h, ACME);
    const server = await h.listen();
    const get = (email: string) =>
      fetch(`http://localhost:${server.port}/c/${slug}/`, {
        headers: { host: h.baseHost, "x-test-user": email },
      });
    try {
      // Rejection-first: a cross-org member and a guest get the opaque not_found, and NEVER
      // the content (§12.0 #3).
      for (const who of [BETA, GUEST]) {
        const res = await get(who);
        const body = await res.text();
        expect(res.status).toBe(404);
        expect(body).not.toContain("org secret");
      }
      // The owner and a same-org member reach the actual content.
      for (const who of [ACME, ACME_OTHER]) {
        const res = await get(who);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("org secret");
      }
    } finally {
      await server.close();
    }
  });

  it("INERT tenancy (no org configured): whole_org serves to any signed-in user (legacy)", async () => {
    client = await makeTestDb(dialect);
    // No CANVAS_DROP_ORG_NAME → inert. partner.test must still be allowed to sign in.
    const config = scenarioConfig({
      CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com,partner.test",
    });
    const h = makeHarness(client, { config });
    const slug = await publishWholeOrg(h, ACME);

    // No org boundary: a different-domain member still reaches it (the safety property —
    // deploying the re-scope changes nothing until an org is named).
    expect(await getBody(h, BETA, `/c/${slug}/`)).toContain("org secret");
  });

  it("/api/me exposes the caller's org for a member and isGuest for an outsider", async () => {
    client = await makeTestDb(dialect);
    await seedOrgs(client);
    const h = makeHarness(client, { config: tenancyConfig() });

    const member = await jsonOf<{ orgs: Array<{ name: string }>; isGuest: boolean }>(
      await h.GET(ACME, "/api/me"),
    );
    expect(member.orgs.map((o) => o.name)).toEqual(["Acme"]);
    expect(member.isGuest).toBe(false);

    const guest = await jsonOf<{ orgs: unknown[]; isGuest: boolean }>(
      await h.GET(GUEST, "/api/me"),
    );
    expect(guest.orgs).toEqual([]);
    expect(guest.isGuest).toBe(true);
  });
});

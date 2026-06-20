import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { applyTenancy, planTenancy, verifyTenancy } from "./cutover.js";

describe.each(DIALECTS)("tenancy cutover (plan 002 U8) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** Seed an org (acme.com), a member (mark@acme.com, admin) + a guest (g@gmail.com),
   *  and a few canvases in mixed tenancy states. */
  async function seed() {
    client = await makeTestDb(dialect);
    const orgs = orgsRepository(client);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const acme = await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });

    const member = await users.upsert({
      providerSub: "m",
      email: "mark@acme.com",
      name: "Mark",
      isAdmin: true,
    });
    const guest = await users.upsert({
      providerSub: "g",
      email: "g@gmail.com",
      name: "Guest",
      isAdmin: false,
    });
    // An admin on a NON-org domain — the cutover should reclassify them as a guest.
    const adminGuest = await users.upsert({
      providerSub: "ag",
      email: "ops@partner.example",
      name: "Ops",
      isAdmin: true,
    });

    const memberWholeOrg = (
      await canvases.create({ ownerId: member.id, slug: "m-shared", apiKeyHash: "k1" })
    ).id;
    await canvases.updateSettings(memberWholeOrg, { access: "whole_org" });
    const guestWholeOrg = (
      await canvases.create({ ownerId: guest.id, slug: "g-shared", apiKeyHash: "k2" })
    ).id;
    await canvases.updateSettings(guestWholeOrg, { access: "whole_org" });
    const guestPrivate = (
      await canvases.create({ ownerId: guest.id, slug: "g-private", apiKeyHash: "k3" })
    ).id;

    return {
      orgs,
      canvases,
      acme,
      ids: { memberWholeOrg, guestWholeOrg, guestPrivate },
      adminGuest,
    };
  }

  it("dry-run classifies users + canvases and writes nothing", async () => {
    const { orgs, canvases, ids } = await seed();
    const plan = await planTenancy(client, orgs);

    expect(plan.users.members).toBe(1);
    expect(plan.users.guests).toBe(2);
    // The admin on a non-org domain is flagged as a reclassified guest.
    expect(plan.users.reclassifiedAdmins.map((a) => a.email)).toContain("ops@partner.example");
    expect(plan.canvases.willAssignOrg).toBe(1); // member's canvas gets the org
    expect(plan.canvases.willClampToPrivate).toBe(1); // guest's whole_org → private

    // No writes happened.
    expect((await canvases.findById(ids.memberWholeOrg))?.orgId).toBeNull();
    expect((await canvases.findById(ids.guestWholeOrg))?.access).toBe("whole_org");
  });

  it("apply homes member canvases by owner domain and clamps guest-owned whole_org", async () => {
    const { orgs, canvases, acme, ids } = await seed();
    const res = await applyTenancy(client, orgs);
    expect(res).toEqual({ assigned: 1, clamped: 1 });

    // Member's whole_org → homed in Acme, still whole_org (now org-scoped).
    const m = await canvases.findById(ids.memberWholeOrg);
    expect(m?.orgId).toBe(acme.id);
    expect(m?.access).toBe("whole_org");
    // Guest's whole_org → clamped to private, org_id stays null (personal).
    const gw = await canvases.findById(ids.guestWholeOrg);
    expect(gw?.access).toBe("private");
    expect(gw?.orgId).toBeNull();
    // Guest's private canvas is untouched.
    const gp = await canvases.findById(ids.guestPrivate);
    expect(gp?.access).toBe("private");
    expect(gp?.orgId).toBeNull();
  });

  it("apply is idempotent — a second run changes nothing and verify passes", async () => {
    const { orgs } = await seed();
    await applyTenancy(client, orgs);
    const second = await applyTenancy(client, orgs);
    expect(second).toEqual({ assigned: 0, clamped: 0 });

    const { ok, plan } = await verifyTenancy(client, orgs);
    expect(ok).toBe(true);
    expect(plan.canvases.willAssignOrg).toBe(0);
    expect(plan.canvases.willClampToPrivate).toBe(0);
  });

  it("post-apply verify catches an injected mismatch (a new unhomed whole_org)", async () => {
    const { orgs, ids } = await seed();
    await applyTenancy(client, orgs);
    // Simulate drift: a member's canvas regressed to null org_id after apply.
    // biome-ignore lint/suspicious/noExplicitAny: test-only dialect seam
    const db = client.db as any;
    const t = dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;
    await db.update(t).set({ orgId: null }).where(eq(t.id, ids.memberWholeOrg));

    const { ok } = await verifyTenancy(client, orgs);
    expect(ok).toBe(false); // the unhomed member canvas is detected
  });
});

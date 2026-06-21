import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { makeOrgMembershipResolver } from "../auth/org-membership.js";
import type { DbClient } from "../db/factory.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { applyReconcile, planReconcile } from "./reconcile.js";

describe.each(DIALECTS)("tenancy reconcile (plan 003 U2) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  /** Acme + a member who's been materialized and put into a team (direct inserts —
   *  teamsRepository is U3). */
  async function seed() {
    client = await makeTestDb(dialect);
    const orgs = orgsRepository(client);
    const orgMembers = orgMembersRepository(client);
    const users = usersRepository(client);
    const schema = dialect === "sqlite" ? sqliteSchema : pgSchema;
    // biome-ignore lint/suspicious/noExplicitAny: dual-dialect test seam
    const db = client.db as any;

    const org = await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });
    const member = await users.upsert({
      providerSub: "m",
      email: "m@acme.com",
      name: "M",
      isAdmin: false,
    });
    // Materialize membership exactly as login would.
    await makeOrgMembershipResolver(orgs, orgMembers)({ id: member.id, email: member.email });

    const teamId = uuidv7();
    await db.insert(schema.teams).values({
      id: teamId,
      orgId: org.id,
      name: "Eng",
      slug: "eng",
      createdBy: member.id,
      createdAt: Date.now(),
    });
    await db
      .insert(schema.teamMembers)
      .values({ id: uuidv7(), teamId, userId: member.id, role: "member", createdAt: Date.now() });

    return { orgs, orgMembers, org, member, schema, db };
  }

  it("dry-run finds nothing while the domain is still configured", async () => {
    const { orgs } = await seed();
    const plan = await planReconcile(client, orgs);
    expect(plan.staleMembers).toHaveLength(0);
    expect(plan.cascadeTeamMembers).toBe(0);
  });

  it("after a domain is removed, dry-run flags the stale member + its team membership", async () => {
    const { orgs } = await seed();
    await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: [] }); // remove the domain
    const plan = await planReconcile(client, orgs);
    expect(plan.staleMembers.map((m) => m.email)).toEqual(["m@acme.com"]);
    expect(plan.cascadeTeamMembers).toBe(1);
  });

  it("apply revokes the stale org_members AND cascades team_members; idempotent", async () => {
    const { orgs, orgMembers, org, member, schema, db } = await seed();
    await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: [] });
    const res = await applyReconcile(client, orgs);
    expect(res).toEqual({ revokedMembers: 1, revokedTeamMembers: 1 });
    expect(await orgMembers.isMember(org.id, member.id)).toBe(false);
    expect(await db.select().from(schema.teamMembers)).toHaveLength(0);
    // second run is a no-op
    expect(await applyReconcile(client, orgs)).toEqual({
      revokedMembers: 0,
      revokedTeamMembers: 0,
    });
  });

  it("leaves a still-valid member (domain still configured) untouched", async () => {
    const { orgs, orgMembers, org, member } = await seed();
    const res = await applyReconcile(client, orgs);
    expect(res).toEqual({ revokedMembers: 0, revokedTeamMembers: 0 });
    expect(await orgMembers.isMember(org.id, member.id)).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { makeOrgMembershipResolver } from "./org-membership.js";

describe.each(DIALECTS)("makeOrgMembershipResolver [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seedAcme() {
    client = await makeTestDb(dialect);
    const orgs = orgsRepository(client);
    const orgMembers = orgMembersRepository(client);
    const users = usersRepository(client);
    const org = await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });
    return {
      orgs,
      orgMembers,
      users,
      resolve: makeOrgMembershipResolver(orgs, orgMembers),
      orgId: org.id,
    };
  }

  /** Create a real user row (the materialized org_members row FKs to users.id). */
  async function user(users: ReturnType<typeof usersRepository>, email: string) {
    return users.upsert({ providerSub: email, email, name: email, isAdmin: false });
  }

  it("classifies a member by exact email-domain match", async () => {
    const { resolve, users, orgId } = await seedAcme();
    const u = await user(users, "user@acme.com");
    expect([...(await resolve({ id: u.id, email: "user@acme.com" }))]).toEqual([orgId]);
    const u2 = await user(users, "user2@acme.com");
    expect([...(await resolve({ id: u2.id, email: "USER2@Acme.COM" }))]).toEqual([orgId]); // normalized
  });

  it("materializes a source='domain' org_members row for a member (idempotent)", async () => {
    const { resolve, users, orgMembers, orgId } = await seedAcme();
    const u = await user(users, "user@acme.com");
    await resolve({ id: u.id, email: "user@acme.com" });
    await resolve({ id: u.id, email: "user@acme.com" }); // again — must not duplicate
    expect(await orgMembers.isMember(orgId, u.id)).toBe(true);
    expect([...(await orgMembers.listOrgIdsForUser(u.id))]).toEqual([orgId]);
  });

  it("a guest materializes NO row and resolves to ∅", async () => {
    const { resolve, users, orgMembers } = await seedAcme();
    const g = await user(users, "guest@gmail.com");
    expect(await resolve({ id: g.id, email: "guest@gmail.com" })).toEqual(new Set());
    expect([...(await orgMembers.listOrgIdsForUser(g.id))]).toEqual([]);
  });

  it("returns the LIVE derived set — a stale materialized row never widens access", async () => {
    const { orgs, resolve, users, orgMembers, orgId } = await seedAcme();
    const u = await user(users, "user@acme.com");
    await resolve({ id: u.id, email: "user@acme.com" }); // materializes the row
    expect(await orgMembers.isMember(orgId, u.id)).toBe(true);
    // Operator removes the domain (boot re-materialization prunes org_domains).
    await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: [] });
    // The materialized row still exists (reconcile not run), but the resolver re-derives
    // LIVE from the now-empty domain config → ∅. The boundary is the resolver, not the table.
    expect(await resolve({ id: u.id, email: "user@acme.com" })).toEqual(new Set());
    expect(await orgMembers.isMember(orgId, u.id)).toBe(true); // still stale until reconcile
  });

  it("a subdomain is NOT a member of the parent org (exact match, KTD2)", async () => {
    const { resolve, users } = await seedAcme();
    const u = await user(users, "user@eng.acme.com");
    expect(await resolve({ id: u.id, email: "user@eng.acme.com" })).toEqual(new Set());
  });

  it("malformed / non-ASCII / domainless emails resolve to ∅ (never throw)", async () => {
    const { resolve, users } = await seedAcme();
    const u = await user(users, "weird@example.org");
    expect(await resolve({ id: u.id, email: "u@café.com" })).toEqual(new Set()); // non-ASCII
    expect(await resolve({ id: u.id, email: "no-at-sign" })).toEqual(new Set());
    expect(await resolve({ id: u.id, email: "" })).toEqual(new Set());
  });

  it("no org configured → every caller is a guest (∅)", async () => {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const resolve = makeOrgMembershipResolver(orgsRepository(client), orgMembersRepository(client));
    const u = await users.upsert({
      providerSub: "user@acme.com",
      email: "user@acme.com",
      name: "u",
      isAdmin: false,
    });
    expect(await resolve({ id: u.id, email: "user@acme.com" })).toEqual(new Set());
  });
});

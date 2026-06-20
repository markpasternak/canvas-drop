import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { orgsRepository } from "../db/repositories/orgs.js";
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
    const org = await orgs.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });
    return { resolve: makeOrgMembershipResolver(orgs), orgId: org.id };
  }

  it("classifies a member by exact email-domain match", async () => {
    const { resolve, orgId } = await seedAcme();
    expect([...(await resolve({ email: "user@acme.com" }))]).toEqual([orgId]);
    expect([...(await resolve({ email: "USER@Acme.COM" }))]).toEqual([orgId]); // normalized
  });

  it("a subdomain is NOT a member of the parent org (exact match, KTD2)", async () => {
    const { resolve } = await seedAcme();
    expect(await resolve({ email: "user@eng.acme.com" })).toEqual(new Set());
  });

  it("an outside / allowlisted / admin-on-other-domain user is a GUEST (∅), not a member", async () => {
    const { resolve } = await seedAcme();
    // The resolver is independent of allowed_emails / ADMIN_EMAILS — a gmail user who can
    // sign in (allowlisted) is still not an org member.
    expect(await resolve({ email: "guest@gmail.com" })).toEqual(new Set());
    expect(await resolve({ email: "admin@partner.example" })).toEqual(new Set());
  });

  it("malformed / non-ASCII / domainless emails resolve to ∅ (never throw)", async () => {
    const { resolve } = await seedAcme();
    expect(await resolve({ email: "u@café.com" })).toEqual(new Set()); // non-ASCII
    expect(await resolve({ email: "no-at-sign" })).toEqual(new Set());
    expect(await resolve({ email: "" })).toEqual(new Set());
  });

  it("no org configured → every caller is a guest (∅)", async () => {
    client = await makeTestDb(dialect);
    const resolve = makeOrgMembershipResolver(orgsRepository(client));
    expect(await resolve({ email: "user@acme.com" })).toEqual(new Set());
  });
});

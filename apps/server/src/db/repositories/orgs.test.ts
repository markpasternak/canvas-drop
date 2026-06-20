import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { orgsRepository } from "./orgs.js";

describe.each(DIALECTS)("orgsRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("ensureOrg is idempotent (same slug → one org, domains de-duped) and normalizes domains", async () => {
    client = await makeTestDb(dialect);
    const repo = orgsRepository(client);

    const a = await repo.ensureOrg({
      name: "Acme",
      slug: "acme",
      domains: ["Acme.com", "eng.acme.com."], // mixed case + trailing FQDN dot
    });
    // Re-run with the same slug + an overlapping domain → still one org, no dup domains.
    const b = await repo.ensureOrg({ name: "Acme Inc", slug: "acme", domains: ["acme.com"] });

    expect(b.id).toBe(a.id);
    expect(b.name).toBe("Acme Inc"); // name updated in place
    expect(await repo.list()).toHaveLength(1);
    expect(await repo.listDomains(a.id)).toEqual(["acme.com", "eng.acme.com"]);
  });

  it("findByDomain returns the owning org on an exact normalized match, null otherwise", async () => {
    client = await makeTestDb(dialect);
    const repo = orgsRepository(client);
    const org = await repo.ensureOrg({ name: "Acme", slug: "acme", domains: ["acme.com"] });

    expect((await repo.findByDomain("acme.com"))?.id).toBe(org.id);
    // Subdomain is NOT a member of the parent (exact match, KTD2).
    expect(await repo.findByDomain("eng.acme.com")).toBeNull();
    expect(await repo.findByDomain("other.com")).toBeNull();
  });

  it("rejects a domain already mapped to a different org (boot guard, KTD4)", async () => {
    client = await makeTestDb(dialect);
    const repo = orgsRepository(client);
    await repo.ensureOrg({ name: "Acme", slug: "acme", domains: ["shared.com"] });
    await expect(
      repo.ensureOrg({ name: "Beta", slug: "beta", domains: ["shared.com"] }),
    ).rejects.toThrow(/already mapped to a different org/);
  });

  it("rejects a malformed domain at the normalization boundary (fail-loud)", async () => {
    client = await makeTestDb(dialect);
    const repo = orgsRepository(client);
    await expect(
      repo.ensureOrg({ name: "Acme", slug: "acme", domains: ["not a domain"] }),
    ).rejects.toThrow(/invalid email domain/);
  });
});

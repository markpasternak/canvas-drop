import { type Config, loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { Logger } from "../log/logger.js";
import { materializeOrg } from "./materialize-org.js";

const noopLog = { info: () => {}, error: () => {}, warn: () => {} } as unknown as Logger;

/** A real Config with the tenancy block overridden (the rest is the dev default). */
function configWithOrg(org: Config["org"]): Config {
  return { ...loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" }), org };
}

describe.each(DIALECTS)("materializeOrg [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("is a no-op when no org is named (tenancy inert)", async () => {
    client = await makeTestDb(dialect);
    const orgs = orgsRepository(client);
    await materializeOrg({
      config: configWithOrg({ name: undefined, domains: [] }),
      orgs,
      log: noopLog,
    });
    expect(await orgs.list()).toHaveLength(0);
  });

  it("materializes the org + normalized domains and is idempotent across boots", async () => {
    client = await makeTestDb(dialect);
    const orgs = orgsRepository(client);
    const config = configWithOrg({ name: "Acme", domains: ["Acme.com", "eng.acme.com"] });

    await materializeOrg({ config, orgs, log: noopLog });
    await materializeOrg({ config, orgs, log: noopLog }); // second boot

    const [org] = await orgs.list();
    expect(org).toBeDefined();
    if (!org) return;
    expect(org.name).toBe("Acme");
    expect(org.slug).toBe("acme");
    expect(await orgs.listDomains(org.id)).toEqual(["acme.com", "eng.acme.com"]);
  });

  it("fails loud when more than one org exists (P1 single-org guard)", async () => {
    client = await makeTestDb(dialect);
    const orgs = orgsRepository(client);
    // Simulate a stale second org from an abandoned multi-org state.
    await orgs.ensureOrg({ name: "Stale", slug: "stale", domains: ["stale.example"] });

    await expect(
      materializeOrg({
        config: configWithOrg({ name: "Acme", domains: ["acme.com"] }),
        orgs,
        log: noopLog,
      }),
    ).rejects.toThrow(/P1 supports exactly one/);
  });
});

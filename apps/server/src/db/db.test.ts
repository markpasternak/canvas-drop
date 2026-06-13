import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "./factory.js";
import { settingsRepository } from "./repositories/settings.js";
import { usersRepository } from "./repositories/users.js";
import { DIALECTS, makeFreshPgTestDb, makeTestDb } from "./testing.js";

describe.each(DIALECTS)("db [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("applies migrations cleanly and is idempotent", async () => {
    // A virgin database, not the shared/reset one, so the clean-apply assertion
    // holds no matter how vitest pools workers.
    client = dialect === "postgres" ? await makeFreshPgTestDb() : await makeTestDb(dialect);
    await client.migrate(); // a second run must be a no-op, not an error
    expect(await usersRepository(client).findById("does-not-exist")).toBeNull();
  });

  it("round-trips epoch-ms timestamps as numbers", async () => {
    client = await makeTestDb(dialect);
    const before = Date.now();
    const u = await usersRepository(client).upsert({
      providerSub: "sub-1",
      email: "a@example.com",
      name: "A",
      isAdmin: false,
    });
    expect(typeof u.createdAt).toBe("number");
    expect(u.createdAt).toBeGreaterThanOrEqual(before);
  });

  it("round-trips nested JSON values identically", async () => {
    client = await makeTestDb(dialect);
    const settings = settingsRepository(client);
    const value = { models: ["fast", "smart"], nested: { n: 1, ok: true }, list: [1, 2, 3] };
    await settings.set("allowlist", value);
    expect(await settings.get("allowlist")).toEqual(value);

    // update path
    await settings.set("allowlist", { models: ["smart"] });
    expect(await settings.get("allowlist")).toEqual({ models: ["smart"] });
    expect(await settings.get("missing")).toBeUndefined();
  });
});

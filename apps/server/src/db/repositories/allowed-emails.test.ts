import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { allowedEmailsRepository } from "./allowed-emails.js";

describe.each(DIALECTS)("allowedEmailsRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("add normalizes to lowercase + trims; isAllowed matches case-insensitively", async () => {
    client = await makeTestDb(dialect);
    const repo = allowedEmailsRepository(client);
    await repo.add("  Partner@External.COM ", "admin-1");

    // Stored normalized.
    const list = await repo.list();
    expect(list.map((e) => e.email)).toEqual(["partner@external.com"]);
    expect(list[0]?.createdBy).toBe("admin-1");

    // isAllowed matches regardless of the caller's casing/whitespace.
    expect(await repo.isAllowed("partner@external.com")).toBe(true);
    expect(await repo.isAllowed("PARTNER@external.com")).toBe(true);
    expect(await repo.isAllowed(" partner@external.com ")).toBe(true);
    expect(await repo.isAllowed("someone@external.com")).toBe(false);
  });

  it("add is idempotent on the unique email index (no duplicate, no crash)", async () => {
    client = await makeTestDb(dialect);
    const repo = allowedEmailsRepository(client);
    await repo.add("dup@x.com", "a");
    await repo.add("Dup@x.com", "b"); // same email, different case + adder
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.email).toBe("dup@x.com");
  });

  it("remove drops the entry", async () => {
    client = await makeTestDb(dialect);
    const repo = allowedEmailsRepository(client);
    const entry = await repo.add("gone@x.com", null);
    await repo.remove(entry.id);
    expect(await repo.isAllowed("gone@x.com")).toBe(false);
    expect(await repo.list()).toHaveLength(0);
  });
});

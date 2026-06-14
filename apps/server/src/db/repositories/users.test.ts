import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { usersRepository } from "./users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe.each(DIALECTS)("usersRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("creates a user with a UUIDv7 id on first upsert", async () => {
    client = await makeTestDb(dialect);
    const repo = usersRepository(client);
    const u = await repo.upsert({
      providerSub: "sub-1",
      email: "a@example.com",
      name: "Ada",
      isAdmin: false,
    });
    expect(u.id).toMatch(UUID_RE);
    expect(u.email).toBe("a@example.com");
    expect(u.isBlocked).toBe(false);
  });

  it("reuses the existing row on repeat upsert (no duplicate) and updates fields", async () => {
    client = await makeTestDb(dialect);
    const repo = usersRepository(client);
    const first = await repo.upsert({
      providerSub: "sub-1",
      email: "a@example.com",
      name: "Ada",
      isAdmin: false,
    });
    const second = await repo.upsert({
      providerSub: "sub-1",
      email: "a@example.com",
      name: "Ada Lovelace",
      isAdmin: true,
    });
    expect(second.id).toBe(first.id); // same row
    expect(second.name).toBe("Ada Lovelace");
    expect(second.isAdmin).toBe(true);
    expect(await repo.findByProviderSub("sub-1")).not.toBeNull();
  });

  it("finds by id and by provider sub", async () => {
    client = await makeTestDb(dialect);
    const repo = usersRepository(client);
    const u = await repo.upsert({
      providerSub: "sub-2",
      email: "b@example.com",
      name: "Grace",
      isAdmin: false,
    });
    expect((await repo.findById(u.id))?.email).toBe("b@example.com");
    expect((await repo.findByProviderSub("sub-2"))?.id).toBe(u.id);
    expect(await repo.findById("nope")).toBeNull();
  });

  it("rejects a duplicate email across different identities", async () => {
    client = await makeTestDb(dialect);
    const repo = usersRepository(client);
    await repo.upsert({
      providerSub: "sub-1",
      email: "dup@example.com",
      name: "One",
      isAdmin: false,
    });
    await expect(
      repo.upsert({ providerSub: "sub-2", email: "dup@example.com", name: "Two", isAdmin: false }),
    ).rejects.toThrow();
  });

  it("bootstrap admin model: a login (env not-admin) never demotes a DB-granted admin", async () => {
    client = await makeTestDb(dialect);
    const repo = usersRepository(client);
    // First sight as an env admin (allowlist seeds it).
    const u = await repo.upsert({ providerSub: "s", email: "a@x.com", name: "A", isAdmin: true });
    expect(u.isAdmin).toBe(true);
    // Subsequent login where the env allowlist no longer lists them (isAdmin:false)
    // must NOT clobber the persisted grant — the bit only ever gets promoted here.
    const again = await repo.upsert({
      providerSub: "s",
      email: "a@x.com",
      name: "A",
      isAdmin: false,
    });
    expect(again.isAdmin).toBe(true);
  });

  it("bootstrap admin model: env can still promote an existing non-admin on login", async () => {
    client = await makeTestDb(dialect);
    const repo = usersRepository(client);
    await repo.upsert({ providerSub: "s", email: "a@x.com", name: "A", isAdmin: false });
    const promoted = await repo.upsert({
      providerSub: "s",
      email: "a@x.com",
      name: "A",
      isAdmin: true,
    });
    expect(promoted.isAdmin).toBe(true);
  });

  it("setAdmin grants and revokes, and persists across a later login", async () => {
    client = await makeTestDb(dialect);
    const repo = usersRepository(client);
    const u = await repo.upsert({ providerSub: "s", email: "a@x.com", name: "A", isAdmin: false });
    await repo.setAdmin(u.id, true);
    expect((await repo.findById(u.id))?.isAdmin).toBe(true);
    // A login (env not-admin) must not revoke the in-app grant.
    await repo.upsert({ providerSub: "s", email: "a@x.com", name: "A", isAdmin: false });
    expect((await repo.findById(u.id))?.isAdmin).toBe(true);
    // Revoke sticks too.
    await repo.setAdmin(u.id, false);
    expect((await repo.findById(u.id))?.isAdmin).toBe(false);
  });

  it("countAdmins counts only admins", async () => {
    client = await makeTestDb(dialect);
    const repo = usersRepository(client);
    await repo.upsert({ providerSub: "a", email: "a@x.com", name: "A", isAdmin: true });
    await repo.upsert({ providerSub: "b", email: "b@x.com", name: "B", isAdmin: false });
    expect(await repo.countAdmins()).toBe(1);
    const c = await repo.upsert({ providerSub: "c", email: "c@x.com", name: "C", isAdmin: false });
    await repo.setAdmin(c.id, true);
    expect(await repo.countAdmins()).toBe(2);
  });

  it("setBlocked persists and a login never resurrects a blocked user", async () => {
    client = await makeTestDb(dialect);
    const repo = usersRepository(client);
    const u = await repo.upsert({ providerSub: "s", email: "a@x.com", name: "A", isAdmin: false });
    await repo.setBlocked(u.id, true);
    expect((await repo.findById(u.id))?.isBlocked).toBe(true);
    // A subsequent login must keep them blocked (isBlocked is not in the upsert set).
    const again = await repo.upsert({
      providerSub: "s",
      email: "a@x.com",
      name: "A",
      isAdmin: false,
    });
    expect(again.isBlocked).toBe(true);
  });
});

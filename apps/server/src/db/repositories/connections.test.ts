import type { ConnectionProfile } from "@canvas-drop/shared/db";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { connectionsRepository } from "./connections.js";
import { usersRepository } from "./users.js";

describe.each(DIALECTS)("connectionsRepository [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => client?.close());

  async function fixture() {
    client = await makeTestDb(dialect);
    const user = await usersRepository(client).upsert({
      providerSub: "admin",
      email: "admin@example.com",
      name: "Admin",
      isAdmin: true,
    });
    const canvas = await canvasesRepository(client).create({
      ownerId: user.id,
      slug: "stocks-1111-2222",
      apiKeyHash: "hash",
    });
    const profile: ConnectionProfile = {
      id: "profile-1",
      key: "stocks",
      label: "Stocks",
      origin: "https://stocks.example.com",
      allowedMethods: ["GET"],
      protectedHeaderNames: ["user-agent"],
      protectedHeadersEnvelope: "encrypted",
      enabled: true,
      createdBy: user.id,
      createdAt: 1,
      updatedAt: 1,
    };
    return { repo: connectionsRepository(client), user, canvas, profile };
  }

  it("enforces unique keys and idempotent grants", async () => {
    const { repo, user, canvas, profile } = await fixture();
    await repo.create(profile);
    await expect(repo.create({ ...profile, id: "profile-2" })).rejects.toThrow();
    expect(
      await repo.attach({
        canvasId: canvas.id,
        connectionId: profile.id,
        createdBy: user.id,
        createdAt: 2,
      }),
    ).toBe(true);
    expect(
      await repo.attach({
        canvasId: canvas.id,
        connectionId: profile.id,
        createdBy: user.id,
        createdAt: 3,
      }),
    ).toBe(false);
    expect((await repo.findGranted(canvas.id, "stocks"))?.profile.id).toBe(profile.id);
  });

  it("deletes a profile and all grants atomically through the FK cascade", async () => {
    const { repo, user, canvas, profile } = await fixture();
    await repo.create(profile);
    await repo.attach({
      canvasId: canvas.id,
      connectionId: profile.id,
      createdBy: user.id,
      createdAt: 2,
    });

    await expect(repo.delete(profile.id)).resolves.toEqual({ deleted: true, revokedGrants: 1 });
    await expect(repo.findGranted(canvas.id, "stocks")).resolves.toBeNull();
    await expect(repo.findById(profile.id)).resolves.toBeNull();
  });

  it("defaults grants to private and atomically bounds public requests across repository instances", async () => {
    const { repo, user, canvas, profile } = await fixture();
    await repo.create(profile);
    await repo.attach({
      canvasId: canvas.id,
      connectionId: profile.id,
      createdBy: user.id,
      createdAt: 2,
    });
    expect((await repo.findGranted(canvas.id, profile.key))?.grant.publicPolicy).toBeNull();
    const policy = { paths: ["/quote"], methods: ["GET" as const], requestsPerDay: 3 };
    await repo.setPublicPolicy(profile.id, canvas.id, policy, "v1");
    const another = connectionsRepository(client);
    const consume = (revision = "v1", day = 20) =>
      another.consumePublicRequest(profile.id, canvas.id, revision, day, 3);
    const results = await Promise.all(Array.from({ length: 10 }, () => consume()));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await consume("stale", 21)).toBe(false);
    expect(await consume("v1", 21)).toBe(true);
    await repo.setPublicPolicy(profile.id, canvas.id, null, "v2");
    expect(await consume("v1", 22)).toBe(false);
    await repo.setPublicPolicy(profile.id, canvas.id, policy, "v3");
    expect(await consume("v3", 21)).toBe(true);
    expect(await consume("v3", 21)).toBe(true);
    expect(await consume("v3", 21)).toBe(false);
  });
});

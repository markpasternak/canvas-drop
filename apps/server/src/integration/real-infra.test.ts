import { S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import { makeDb } from "../db/factory.js";
import { usersRepository } from "../db/repositories/users.js";
import { S3Driver } from "../storage/s3.js";

/**
 * Real-infrastructure smoke tests for the PRODUCTION drivers — node-postgres
 * against a real Postgres server and the real S3Driver against MinIO. These
 * cover what the fast suite cannot: pglite is the PG engine but not the wire
 * driver, and the S3 unit tests use an in-memory fake.
 *
 * Gated on env so they run only in CI (or when an operator opts in); skipped
 * locally with no Docker. The full dialect-drift coverage lives in the main
 * suite (sqlite + pglite) and runs everywhere.
 */
const PG_URL = process.env.CANVAS_DROP_TEST_DATABASE_URL;
const S3_ENDPOINT = process.env.CANVAS_DROP_TEST_S3_ENDPOINT;

describe.skipIf(!PG_URL)("real Postgres (node-postgres driver)", () => {
  it("migrates and round-trips a user against a live server", async () => {
    const config = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_DB: "postgres",
      CANVAS_DROP_DATABASE_URL: PG_URL,
    });
    const client = makeDb(config);
    try {
      await client.migrate();
      const repo = usersRepository(client);
      const u = await repo.upsert({
        providerSub: "real-pg",
        email: `u${Date.now()}@example.com`,
        name: "Real",
        isAdmin: false,
      });
      expect((await repo.findById(u.id))?.id).toBe(u.id);
    } finally {
      await client.close();
    }
  });
});

describe.skipIf(!S3_ENDPOINT)("real S3 (MinIO via S3Driver)", () => {
  it("round-trips an object against a live S3-compatible endpoint", async () => {
    const bucket = process.env.CANVAS_DROP_TEST_S3_BUCKET ?? "canvas-drop-test";
    const client = new S3Client({
      endpoint: S3_ENDPOINT,
      region: process.env.CANVAS_DROP_TEST_S3_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.CANVAS_DROP_TEST_S3_ACCESS_KEY ?? "minioadmin",
        secretAccessKey: process.env.CANVAS_DROP_TEST_S3_SECRET_KEY ?? "minioadmin",
      },
    });
    const driver = new S3Driver(client, bucket);
    const key = `smoke/${Date.now()}.txt`;
    await driver.put(key, new TextEncoder().encode("real s3"));
    const got = await driver.get(key);
    expect(Buffer.from(got as Uint8Array).toString()).toBe("real s3");
    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
  });
});

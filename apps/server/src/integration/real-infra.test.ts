import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "@canvas-drop/shared";
import { Client } from "pg";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { makeDb } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { deployEngine } from "../deploy/engine.js";
import type { DeployEntry } from "../deploy/ingest.js";
import { memStorage } from "../storage/mem.js";
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
const RUN_ID = (process.env.CANVAS_DROP_TEST_RUN_ID ?? randomUUID()).replace(/[^a-zA-Z0-9_]/g, "_");

function quoteIdent(id: string): string {
  return `"${id.replaceAll('"', '""')}"`;
}

async function withIsolatedDatabase<T>(
  baseUrl: string,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const original = new URL(baseUrl);
  const baseName = basenameFromPath(original.pathname) || "canvasdrop_test";
  const dbName = `${baseName.slice(0, 36)}_${RUN_ID.slice(0, 24)}`;
  const admin = new URL(baseUrl);
  admin.pathname = "/postgres";

  const adminClient = new Client({ connectionString: admin.toString() });
  await adminClient.connect();
  try {
    await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
    await adminClient.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
  } finally {
    await adminClient.end();
  }

  const isolated = new URL(baseUrl);
  isolated.pathname = `/${dbName}`;
  try {
    return await run(isolated.toString());
  } finally {
    const cleanupClient = new Client({ connectionString: admin.toString() });
    await cleanupClient.connect();
    try {
      await cleanupClient.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
    } finally {
      await cleanupClient.end();
    }
  }
}

function basenameFromPath(pathname: string): string {
  return pathname.replace(/^\//, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

describe.skipIf(!PG_URL)("real Postgres (node-postgres driver)", () => {
  it("migrates and round-trips a user against a live server", async () => {
    await withIsolatedDatabase(PG_URL as string, async (url) => {
      const config = loadConfig({
        CANVAS_DROP_AUTH_MODE: "dev",
        CANVAS_DROP_DB: "postgres",
        CANVAS_DROP_DATABASE_URL: url,
      });
      const client = makeDb(config);
      try {
        await client.migrate();
        const repo = usersRepository(client);
        const u = await repo.upsert({
          providerSub: "real-pg",
          email: `u-${RUN_ID}@example.com`,
          name: "Real",
          isAdmin: false,
        });
        expect((await repo.findById(u.id))?.id).toBe(u.id);
      } finally {
        await client.close();
      }
    });
  });
});

// Deployment coordination under TRUE concurrency (plan 2026-09-12, KTD2/KTD3, AE2). The
// in-process PGlite leg serializes statements, so only a networked Postgres exercises the
// partial unique index and the single-statement compare-and-swap across separate
// connections. Each engine gets its own node-postgres client (its own connection pool).
describe.skipIf(!PG_URL)("real Postgres — deployment coordination under concurrency", () => {
  const silent = pino({ level: "silent" });
  const enc = (s: string) => new TextEncoder().encode(s);
  async function* one(body: string): AsyncGenerator<DeployEntry> {
    yield { path: "index.html", bytes: enc(body) };
  }

  it("two connections deploying one release keep exactly one ready version; a third with a stale token is refused (AE2, R8)", async () => {
    await withIsolatedDatabase(PG_URL as string, async (url) => {
      const config = loadConfig({
        CANVAS_DROP_AUTH_MODE: "dev",
        CANVAS_DROP_DB: "postgres",
        CANVAS_DROP_DATABASE_URL: url,
      });
      const clients: DbClient[] = [makeDb(config), makeDb(config), makeDb(config)];
      try {
        await clients[0]?.migrate();
        const storage = memStorage();
        const engineFor = (client: DbClient) =>
          deployEngine({
            config,
            canvases: canvasesRepository(client),
            versions: versionsRepository(client),
            drafts: draftsRepository(client),
            storage,
            log: silent,
            waitOptions: { intervalMs: 20 },
          });
        const c0 = clients[0] as DbClient;
        const owner = await usersRepository(c0).upsert({
          providerSub: `coord-${RUN_ID}`,
          email: `coord-${RUN_ID}@example.com`,
          name: "Coord",
          isAdmin: false,
        });
        const canvases = canvasesRepository(c0);
        const cv = await canvases.create({
          ownerId: owner.id,
          slug: `coord-${RUN_ID}`.slice(0, 40),
          apiKeyHash: `k-${RUN_ID}`,
        });
        const t0 = cv.publicationToken;

        const [a, b] = await Promise.all([
          engineFor(c0).deploy(cv, "api", one("a"), owner.id, {
            coordination: { releaseId: "R" },
          }),
          engineFor(clients[1] as DbClient).deploy(cv, "api", one("b"), owner.id, {
            coordination: { releaseId: "R" },
          }),
        ]);
        expect([a.outcome, b.outcome].sort()).toEqual(["already_current", "published"]);
        expect(a.versionId).toBe(b.versionId);
        const versions = versionsRepository(c0);
        const rows = await versions.listByCanvas(cv.id);
        const ready = rows.filter((v) => v.status === "ready");
        expect(ready).toHaveLength(1);
        expect(ready[0]?.releaseId).toBe("R");
        expect(rows.filter((v) => v.status === "pending")).toHaveLength(0);
        expect((await canvases.findById(cv.id))?.currentVersionId).toBe(ready[0]?.id);

        // A third publisher holding the pre-publication token is refused atomically.
        await expect(
          engineFor(clients[2] as DbClient).deploy(cv, "api", one("c"), owner.id, {
            coordination: { expectedPublicationToken: t0 },
          }),
        ).rejects.toMatchObject({ code: "PUBLICATION_CHANGED" });
        expect((await canvases.findById(cv.id))?.currentVersionId).toBe(ready[0]?.id);
        expect(
          (await versions.listByCanvas(cv.id)).filter((v) => v.status === "ready"),
        ).toHaveLength(1);
      } finally {
        for (const c of clients) await c.close();
      }
    });
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
    const key = `smoke/${RUN_ID}/${randomUUID()}.txt`;
    try {
      await driver.put(key, new TextEncoder().encode("real s3"));
      const got = await driver.get(key);
      expect(Buffer.from(got as Uint8Array).toString()).toBe("real s3");
    } finally {
      await driver.delete(key);
    }
    expect(await driver.exists(key)).toBe(false);
  });
});

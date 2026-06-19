import { computeSearchText } from "@canvas-drop/shared";
import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { eq, isNull } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { backfillSearchText, countMissingSearchText } from "./backfill-search-text.js";
import type { DbClient } from "./factory.js";
import { canvasesRepository } from "./repositories/canvases.js";
import { usersRepository } from "./repositories/users.js";
import { DIALECTS, makeTestDb } from "./testing.js";

/** The canvases table for the active dialect (mirrors the dual-dialect db seam). */
// biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam (mirrors the repo).
const tableFor = (client: DbClient): any =>
  client.dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;

/** Force `search_text` back to NULL for a canvas, simulating a row that predates the
 *  column being maintained on write (the live `create` always seeds the blob). */
async function nullSearchText(client: DbClient, id: string): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam.
  const db = client.db as any;
  const t = tableFor(client);
  await db.update(t).set({ searchText: null }).where(eq(t.id, id));
}

/** Read one canvas's stored `search_text` (the raw column, not the repo projection). */
async function searchTextOf(client: DbClient, id: string): Promise<string | null> {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam.
  const db = client.db as any;
  const t = tableFor(client);
  const rows = (await db
    .select({ searchText: t.searchText })
    .from(t)
    .where(eq(t.id, id))
    .limit(1)) as Array<{ searchText: string | null }>;
  return rows[0]?.searchText ?? null;
}

/** Count rows with a NULL `search_text` (full count, not the bounded boot guard). */
async function countNullRows(client: DbClient): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam.
  const db = client.db as any;
  const t = tableFor(client);
  const rows = (await db.select({ id: t.id }).from(t).where(isNull(t.searchText))) as Array<{
    id: string;
  }>;
  return rows.length;
}

async function seedUser(client: DbClient, sub: string) {
  return usersRepository(client).upsert({
    providerSub: sub,
    email: `${sub}@example.com`,
    name: sub,
    isAdmin: false,
  });
}

describe.each(DIALECTS)("backfillSearchText [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("populates NULL search_text rows and is reflected by the boot guard", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const owner = await seedUser(client, "owner");

    const a = await canvases.create({
      ownerId: owner.id,
      slug: "alpha-1111-2222",
      apiKeyHash: "h1",
      title: "Weather Dashboard",
      description: "A café forecast",
    });
    const b = await canvases.create({
      ownerId: owner.id,
      slug: "bravo-1111-2222",
      apiKeyHash: "h2",
      title: "Notes",
    });
    // Simulate legacy rows: both predate the maintained column.
    await nullSearchText(client, a.id);
    await nullSearchText(client, b.id);

    // Before: the boot guard sees missing rows, the full count is 2.
    expect(await countMissingSearchText(client)).toBeGreaterThan(0);
    expect(await countNullRows(client)).toBe(2);

    const filled = await backfillSearchText(client);
    expect(filled).toBe(2);

    // After: nothing missing, and each blob matches computeSearchText byte-for-byte
    // (same source of truth as the live write paths — accent-folded "café"→"cafe").
    expect(await countMissingSearchText(client)).toBe(0);
    expect(await countNullRows(client)).toBe(0);
    expect(await searchTextOf(client, a.id)).toBe(
      computeSearchText({
        title: "Weather Dashboard",
        description: "A café forecast",
        tags: null,
        slug: "alpha-1111-2222",
      }),
    );
    expect(await searchTextOf(client, b.id)).toBe(
      computeSearchText({ title: "Notes", description: null, tags: null, slug: "bravo-1111-2222" }),
    );
  });

  it("is idempotent: NULL-only, leaves already-populated rows untouched", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const owner = await seedUser(client, "owner");

    const live = await canvases.create({
      ownerId: owner.id,
      slug: "live-1111-2222",
      apiKeyHash: "h1",
      title: "Live Row",
    });
    const legacy = await canvases.create({
      ownerId: owner.id,
      slug: "old-1111-2222",
      apiKeyHash: "h2",
      title: "Legacy Row",
    });
    await nullSearchText(client, legacy.id);

    // First pass touches ONLY the one NULL row.
    expect(await backfillSearchText(client)).toBe(1);
    // Second pass is a no-op — nothing is NULL anymore.
    expect(await backfillSearchText(client)).toBe(0);
    expect(await countMissingSearchText(client)).toBe(0);

    // The already-populated live row is unchanged (still its create-time blob).
    expect(await searchTextOf(client, live.id)).toBe(
      computeSearchText({
        title: "Live Row",
        description: null,
        tags: null,
        slug: "live-1111-2222",
      }),
    );
  });

  it("the --all path recomputes EVERY row, even ones that already have a blob", async () => {
    client = await makeTestDb(dialect);
    const canvases = canvasesRepository(client);
    const owner = await seedUser(client, "owner");

    const cv = await canvases.create({
      ownerId: owner.id,
      slug: "recompute-1111",
      apiKeyHash: "h1",
      title: "Recompute Me",
    });
    // Corrupt the stored blob; --all must rewrite it from the row's real fields.
    // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam.
    const db = client.db as any;
    const t = tableFor(client);
    await db.update(t).set({ searchText: "stale-garbage" }).where(eq(t.id, cv.id));

    // NULL-only would skip it (it's non-null); --all rewrites it.
    expect(await backfillSearchText(client)).toBe(0);
    expect(await searchTextOf(client, cv.id)).toBe("stale-garbage");

    const recomputed = await backfillSearchText(client, { all: true });
    expect(recomputed).toBe(1);
    expect(await searchTextOf(client, cv.id)).toBe(
      computeSearchText({
        title: "Recompute Me",
        description: null,
        tags: null,
        slug: "recompute-1111",
      }),
    );
  });
});

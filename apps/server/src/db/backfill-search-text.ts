/**
 * Shared core for the denormalized `search_text` backfill (plan 2026-06-19, KTD1).
 *
 * One implementation reused by BOTH the manual `pnpm backfill:search-text` script
 * (apps/server/scripts/backfill-search-text.ts) and the idempotent boot-time
 * backfill (apps/server/src/index.ts), so a hand-run and an auto-run can never
 * diverge. Reuses the SAME `computeSearchText()` the live write paths use, so
 * backfilled and live-maintained rows stay byte-identical.
 *
 * `search_text` was added as a nullable column (U1) and is maintained on every
 * subsequent write by the canvases repository (create / updateSettings /
 * regenerateSlug). Rows from before that change carry NULL and would be invisible
 * to `?q=` until next edited — this populates them once.
 *
 * It is TS, NOT a SQL migration step: the composition needs `normalize()`
 * (accent-stripping is not portable across SQLite/Postgres) and flattening the JSON
 * `tags` array would be dialect-divergent in raw SQL.
 *
 * Idempotent (NULL-only by default; `all` recomputes every row). Touches ONLY
 * `search_text` — no other column, no `updated_at` bump (the blob is derived, not a
 * user-visible change). Updates are applied in chunked transactions so a partial
 * failure can't leave the column half-populated.
 */
import { computeSearchText } from "@canvas-drop/shared";
import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { eq, isNull } from "drizzle-orm";
import type { DbClient } from "./factory.js";

/** Rows per transaction — a partial failure rolls back only the in-flight chunk,
 *  never the chunks already committed, so a re-run resumes cleanly. */
export const BACKFILL_CHUNK_SIZE = 500;

interface SearchTextRow {
  id: string;
  title: string;
  description: string | null;
  tags: unknown;
  slug: string;
}

/**
 * Populate `search_text` for rows that need it.
 *
 * @param all  false (default): only rows where `search_text IS NULL` (boot/normal).
 *             true: recompute EVERY row (e.g. after a `normalize()` change).
 * @returns the number of rows updated.
 */
export async function backfillSearchText(
  client: DbClient,
  { all = false }: { all?: boolean } = {},
): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam (mirrors the repo).
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;

  const rows = (await db
    .select({ id: t.id, title: t.title, description: t.description, tags: t.tags, slug: t.slug })
    .from(t)
    .where(all ? undefined : isNull(t.searchText))) as SearchTextRow[];

  // Apply one chunk's updates against an executor (`db` or a transaction `tx`).
  const applyChunk = async (exec: typeof db, chunk: SearchTextRow[]): Promise<void> => {
    for (const row of chunk) {
      const searchText = computeSearchText({
        title: row.title,
        description: row.description,
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : null,
        slug: row.slug,
      });
      await exec.update(t).set({ searchText }).where(eq(t.id, row.id));
    }
  };

  let updated = 0;
  for (let i = 0; i < rows.length; i += BACKFILL_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BACKFILL_CHUNK_SIZE);
    // One transaction per chunk on Postgres: if any update throws, the whole chunk rolls
    // back and the error propagates — already-committed chunks survive, and a re-run
    // (NULL-only) picks up exactly the rows left unpopulated. better-sqlite3 is
    // synchronous and single-writer, and drizzle's sqlite transaction() rejects an async
    // callback; the chunk's awaited updates already run without interleaving, so we apply
    // them against the bare `db` there.
    if (client.dialect === "sqlite") {
      await applyChunk(db, chunk);
    } else {
      await db.transaction((tx: typeof db) => applyChunk(tx, chunk));
    }
    updated += chunk.length;
  }
  return updated;
}

/**
 * Boot-time guard: count rows still missing `search_text`. Cheap single aggregate;
 * the boot path skips the backfill entirely when this is 0 (the steady state), so a
 * normal restart pays only this count, not a full table scan + rewrite.
 */
export async function countMissingSearchText(client: DbClient): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam (mirrors the repo).
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.canvases : pgSchema.canvases;
  const rows = (await db
    .select({ id: t.id })
    .from(t)
    .where(isNull(t.searchText))
    .limit(1)) as Array<{ id: string }>;
  return rows.length;
}

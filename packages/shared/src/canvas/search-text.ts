/**
 * Forgiving-search text composition (plan 2026-06-19 dashboard UX sweep, KTD1).
 *
 * The single source of truth for the denormalized `search_text` column and the
 * query side of the search, so backfilled rows, live-maintained rows, and the
 * `?q=` matcher can never diverge. Pure string logic with NO node imports, so it
 * stays bundle-safe for any consumer (server write paths, the backfill script,
 * and the dialect-portable LIKE matcher).
 *
 * Why a denormalized blob instead of dialect FTS: identical case/accent/spacing-
 * forgiving matching on BOTH SQLite and Postgres without a dialect-specific
 * full-text/trigram engine (see docs/solutions/2026-06-13-dual-dialect-drizzle-seam.md).
 */

/**
 * `normalize(s) = lowercase(strip_accents(collapse_whitespace(trim(s))))`.
 *
 * Accents are stripped via Unicode NFD decomposition + removal of the combining
 * marks (U+0300–U+036F), so `café` and `cafe` match. Whitespace runs collapse to
 * a single space; leading/trailing whitespace is trimmed. The result is lowercase.
 * This contract is PINNED — changing it requires re-running the backfill.
 */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The search-relevant fields of a canvas, named to match the stored row. */
export interface SearchableCanvasFields {
  title: string;
  /** The canvas description; null/undefined contributes the empty string. */
  description?: string | null;
  /** Tags in stored order; joined with single spaces. */
  tags?: readonly string[] | null;
  slug: string;
}

/**
 * `searchText = normalize(title + " " + (description ?? "") + " " + tags.join(" ") + " " + slug)`.
 *
 * Composition is PINNED (KTD1): a null/absent description contributes `""`, tags are
 * joined in stored order with single spaces, fields are separated by single
 * spaces. `normalize()` then collapses any resulting whitespace runs, so empty
 * fields never widen or break a token boundary.
 */
export function computeSearchText(canvas: SearchableCanvasFields): string {
  const tags = Array.isArray(canvas.tags)
    ? canvas.tags.filter((t): t is string => typeof t === "string")
    : [];
  const parts = [canvas.title, canvas.description ?? "", tags.join(" "), canvas.slug];
  return normalize(parts.join(" "));
}

/**
 * Escape the LIKE metacharacters `\ % _` in a single normalized token so they
 * match literally under `ESCAPE '\'`. Mirrors the existing escape pattern in
 * `apps/server/src/db/repositories/canvases.ts`.
 */
export function escapeLikeToken(token: string): string {
  return token.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Split a raw query into normalized, escaped LIKE patterns — one `%token%` per
 * whitespace-separated token of the normalized query. Each is AND-ed against the
 * stored `search_text` by the caller. An all-whitespace/empty query yields `[]`
 * (the caller then applies no search filter).
 */
export function searchTextPatterns(rawQuery: string): string[] {
  const q = normalize(rawQuery);
  if (q === "") return [];
  return q.split(" ").map((tok) => `%${escapeLikeToken(tok)}%`);
}

# Plan: Canvas popularity — views on the list + "Most popular" sort

- **Status:** proposed
- **Branch:** `feat/usability-improvements` (worktree `../canvas-drop-usability`, off `origin/main`)
- **Date:** 2026-06-18
- **Tracking issue:** TBD

## Goal

Surface usage on the **Your-canvases list** (it currently shows none) and let owners
**sort by popularity**, without putting a live aggregate over the `usage_events` log on
the hot list path.

Two product decisions (from Mark):
- **Popularity = trending (recent 30-day) by default**, but also keep a stored **all-time**
  view counter for the details surface / future use.
- Rows/cards display a **view count + last-viewed** relative time.

## Performance posture (the load-bearing decision)

- `usage_events` is an append-only log (90-day retention), indexed `(canvasId, createdAt)`.
- Sorting a list by popularity must rank the **whole filtered owner set**, then paginate —
  you can't lazily aggregate one page. So the metric must be cheap across all of one owner's
  canvases.
- We avoid a live join/GROUP BY on the **default** path entirely:
  - **`lastViewedAt`** is denormalized onto `canvases` → "last viewed Nd ago" is O(1) per row,
    free on every list response regardless of sort.
  - **`viewCount`** (all-time) is denormalized onto `canvases`, bumped inside the existing
    deduped `recordView` → available O(1), powers the details lifetime figure.
  - **Recent (30d) view counts** — the trending number shown on rows and the `popular` sort
    key — come from **one batched, indexed `GROUP BY` over `usage_events`** scoped to the
    owner's canvas IDs and `createdAt >= now-30d`. This only runs to (a) annotate the ≤48
    returned rows, and (b) rank when `sort=popular`. At single-org / single-VPS scale with a
    bounded 90-day log, that grouped index scan is cheap. Short per-owner in-memory memo
    (≈60s) blunts rapid refetches.

Net: default sort path = unchanged (no usage touched beyond the two new canvas columns).
Trending number + popular sort = one bounded indexed aggregate, optionally memoized.

Greenfield (data clearable) → **no migration/backfill**. New columns default `0` / `null`;
existing rows are correct as-is.

## Units

### U1 — Schema: denormalized view columns (dual-dialect)
- Add to `canvases` in **both** `packages/shared/src/db/schema.pg.ts` and `schema.sqlite.ts`
  via the shared column helpers, in lockstep:
  - `viewCount` — integer, `NOT NULL DEFAULT 0` (all-time deduped views).
  - `lastViewedAt` — epoch-ms, nullable.
- Update the shared inferred `Canvas` type consumers as needed.
- **Gate:** schema-parity test green on both dialects.

### U2 — Record path: bump counters on a counted view
- In `recordView` (`apps/server/src/canvas/serve.ts` → `UsageEventsRepository.recordView`,
  `apps/server/src/db/repositories/usage-events.ts`): when a view row is actually inserted
  (the 30-min dedup returns "added"), also `UPDATE canvases SET viewCount = viewCount + 1,
  lastViewedAt = ? WHERE id = ?`. Stays fire-and-forget/best-effort like today; failure must
  not break serving.
- **Test:** deduped repeat view within window does **not** double-bump; a counted view bumps
  both `viewCount` and `lastViewedAt`.

### U3 — Repository: recent-count aggregate + `popular` sort
- Add `recentViewCounts(canvasIds: string[], sinceMs): Map<id, number>` to the usage repo —
  one `GROUP BY canvasId` over `type='view' AND createdAt >= sinceMs AND canvasId IN (...)`.
  Empty input → empty map (no query).
- Extend `listByOwnerFiltered` to accept `sort: "...| "popular"`:
  - Non-popular sorts: unchanged.
  - `popular`: fetch filtered IDs + `updatedAt` (same WHERE), call `recentViewCounts`, sort by
    `(recentCount desc, updatedAt desc, id desc)` for a stable tiebreak, paginate in app, then
    hydrate the page's rows. `total` from the same WHERE count.
- **Test:** `popular` orders by 30-day views with the documented tiebreak; pagination is stable
  across pages; dual-dialect.

### U4 — Route + shared types: enrich list, accept new sort
- `GET /api/canvases` (`apps/server/src/routes/management.ts`): add `popular` to the `sort`
  zod enum (`.catch("updated")` unchanged). Enrich each `CanvasListItem` with `recentViews`
  (30d, from the batched aggregate over the returned page) and surface `viewCount` +
  `lastViewedAt` (already on the row). Optional ≈60s per-owner memo on the aggregate.
- Update shared `CanvasListItem` (`apps/dashboard/src/lib/api.ts` + server-side type) with the
  new fields.
- **Test:** route returns `recentViews`/`lastViewedAt`; `sort=popular` orders correctly;
  malformed sort still falls back to `updated`.

### U5 — Dashboard UI: display + sort control
- Add **"Most popular"** to the sort select (`apps/dashboard/src/routes/index.tsx`).
  Default sort stays **Recently updated** (popular is opt-in; the *popularity metric* defaults
  to the recent window per the decision).
- Show on each row (`CanvasList.tsx` / `CanvasRow`) and card (`CanvasCard`): the recent view
  count (e.g. "12 views") and a relative "last viewed Nd ago" (empty/"—" when never viewed).
- Keep it quiet visually — one subtle metric line, consistent with the editorial list rows.
- **Verify:** screenshot the list in both view modes; confirm ordering when "Most popular" is
  selected.

### U6 — MCP parity (agent-native rule)
- `list_canvases` MCP tool: accept `sort: "popular"` and include `recentViews` / `viewCount` /
  `lastViewedAt` in its items, wrapping the **same** service layer as the route (no parallel
  impl, same owner scoping). This keeps "anything a user can do in the UI, an agent can do over
  MCP" intact for the new sort + numbers.
- `get_canvas` (optional): expose `viewCount` / `lastViewedAt` for symmetry; full stats already
  live in `get_canvas_usage`.
- **Test:** MCP `list_canvases` with `sort=popular` returns owner-scoped, popularity-ordered
  items.

## Out of scope
- Unique-viewer counts on the list (needs distinct aggregation per row — not chosen).
- Changing the default list sort to popularity.
- Backfilling historical `viewCount` (greenfield; not needed).
- Gallery popularity sort (this plan is the owner's Your-canvases surface only).

## Gates / done
- `pnpm lint && pnpm typecheck && pnpm test` green locally on **both** dialects.
- `/ce-code-review` on the branch; fix real findings (weight to the trust model — counter
  integrity on the record path is the one correctness-sensitive spot).
- CI matrix green on the PR → squash-merge, delete branch, close issue, capture learnings.

---
title: useInfiniteQuery + keyset pagination — refetch replays stored cursors, so dedupe
type: bug
area: dashboard
date: 2026-06-14
---

For anyone wiring `useInfiniteQuery` (TanStack Query v5) over a **keyset**-paginated
list in the dashboard — the admin all-canvases table was the first (M7 admin panel,
PR #26). Builds on [[dashboard-spa-patterns]] and the keyset-on-UUIDv7-id rule in
[[admin-and-rate-limit-hardening]].

## The trap: invalidation refetches every loaded page against its STORED cursor

React Query v5 does **not** re-walk `getNextPageParam` on an invalidation/refetch.
It refetches each already-loaded page with the **`pageParam` it stored when that
page was first fetched** (`data.pageParams`). For an *offset* list that's fine.
For a **keyset** list (`WHERE id < cursor ORDER BY id DESC`), the stored cursor is
a specific row id — and if the underlying dataset shifted between the original
fetch and the refetch, those frozen cursors no longer line up:

- A row that was the page-1/page-2 **boundary** gets soft-deleted (or otherwise
  drops out of the filter) by a *different* user. The admin then fires any mutation
  (`invalidateQueries({ queryKey: ['admin'] })`) or the query refetches on focus.
- Page 1 refetches (cursor = `undefined`) and now pulls the next row up into the
  boundary slot. Page 2 refetches with its **stale** stored cursor and returns a
  window that **overlaps** page 1 → the boundary row appears in *two* pages.
- `flatMap(p => p.canvases)` then yields a **duplicate id**, and React throws a
  duplicate-key warning with unstable row rendering. The mirror case (a concurrent
  *insert*, UUIDv7 sorts newest-first) **silently skips** a row instead.

This is not a server bug — the keyset endpoint is correct per request. It's the
client replaying point-in-time cursors against a moving dataset.

## The fix: dedupe the flattened pages by id (first occurrence wins)

```ts
function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}
const rows = dedupeById(query.data?.pages.flatMap((p) => p.canvases) ?? []);
```

Cheap, local, and it makes the duplicate-key invariant violation structurally
impossible regardless of *why* pages overlap. **First-occurrence-wins** keeps the
fresher page-1 copy over the stale page-2 one.

Heavier alternatives, and why dedupe was chosen here (trusted single-admin, low
concurrency — calibrate to that):

- **`resetQueries` instead of `invalidateQueries`** on mutation → drops back to
  page 1 and re-pages cleanly, fixing *both* duplicate and skip. Costs the admin's
  "Load more" scroll position. Reasonable after a consequential action; overkill
  for this surface.
- **`maxPages`** — doesn't apply; keyset can't collapse to one growing page.

The residual **skip**-on-insert case is left as accepted: rarer, less harmful than
a React crash, and a manual refresh resolves it. Revisit if this ever moves to a
high-concurrency multi-admin context.

## Test it by making two pages overlap

Mock page 1 → `{ canvases: [ROW], nextCursor: "cur1" }` and
page 2 (`?cursor=cur1`) → `{ canvases: [ROW, other], nextCursor: null }` (ROW
repeated), click **Load more**, then assert
`screen.getAllByText(ROW.title)` has length **1**. That pins the dedupe directly,
independent of the race that produces the overlap.

## While here: keyset cursor is a string, type it as one

The cursor is the last row's **id** (a `text` column), not a number. The client
had it typed `number | null`; the server returns `string | null`
(`rows.at(-1)?.id ?? null`). `getNextPageParam: (last) => last.nextCursor ??
undefined` (null→undefined is what v5 reads as "no more pages").

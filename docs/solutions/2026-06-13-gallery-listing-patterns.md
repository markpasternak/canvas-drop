---
title: Gallery listing (M8) — the §12 read predicate, dual-dialect JSON tag query, and the keepPreviousData reset trap
type: architecture
area: data
date: 2026-06-13
---

Reference for anyone touching the opt-in gallery (`/api/gallery`,
`canvasesRepository.listGallery`, `apps/dashboard/src/routes/gallery.tsx`) or any
future cross-owner *read* surface. Builds on
[[2026-06-13-auth-invariant-checklist]], [[2026-06-13-dual-dialect-drizzle-seam]],
and [[2026-06-13-dashboard-spa-patterns]].

## The gallery is the first cross-owner read — the §12 predicate is the whole feature

A gallery shows one member pointers to *other* members' canvases, so the
visibility predicate is the security boundary. It lives in **one SQL `WHERE`**
inside `listGallery`, evaluated per request with no caching (same philosophy as
`decideCanvasAccess`), so revoke / expiry / archive / disable / delete / un-list
all drop a canvas on the very next call:

```
status='active' AND shared AND gallery_listed
  AND (shared_expires_at IS NULL OR shared_expires_at > now)
  AND current_version_id IS NOT NULL
```

- The predicate is in SQL, **not** JS-after-a-broad-fetch, so the route can't
  forget a clause and the DB never returns a non-listed row to the projection.
- `now` is passed in by the route (one `Date.now()` at the call site) so the
  expiry clause is deterministic and testable.
- **`current_version_id IS NOT NULL` is load-bearing and easy to miss.** A canvas
  can be shared+listed but never deployed (or fully pruned) — it would satisfy the
  obvious four clauses yet 404 on open (`serve.ts` → `notFound("unpublished")`).
  Without this clause the gallery renders dead links. A multi-agent review caught
  this; it's the canonical "gallery shows a canvas it shouldn't" case. Test the
  never-deployed exclusion explicitly.
- A password-gated canvas **is** listed (the gallery hands out links; the gate
  enforces on open). `hasPassword` is surfaced; no password material leaves the DB.

## Owner metadata: explicit projection, never a row spread (the me.ts rule, second surface)

`listGallery` `innerJoin`s `users` and `select`s **only** `users.name` +
`users.avatar_url`. The route then projects to an explicit `GalleryItemDto` field
list — never `{...canvas}` / `{...userRow}`. The repo `select({ canvas: t, ... })`
pulls the *full* canvas row (incl. `password_hash`, `api_key_hash`) into memory, so
the explicit route projection is the only thing keeping those out of the response.
Guard it with an **exact-key assertion** on the serialized body
(`Object.keys(item).sort()` equals the public set), not a hand-list of forbidden
keys — a future spread or new field then fails the test instead of leaking. Note
`me.ts` intentionally returns `email`; the gallery must not — don't copy-paste it.

## Dual-dialect JSON-array tag membership is the one query that must branch on dialect

`gallery_tags` is a `c.json` column (TEXT-json on SQLite, real `jsonb` on
Postgres). Exact tag membership is the only genuinely dialect-divergent query:

```ts
client.dialect === "sqlite"
  ? sql`exists (select 1 from json_each(${t.galleryTags}) where value = ${opts.tag})`
  : sql`${t.galleryTags} @> ${JSON.stringify([opts.tag])}::jsonb`
```

**The Postgres bind is a trap:** `@>` needs a JSON *string* (`JSON.stringify([tag])`
→ `'["x"]'::jsonb`). Binding a JS array (`[tag]`) makes drizzle serialize a Postgres
`text[]` literal `{x}`, and `jsonb @> text[]` is a type error. Both forms are
exact-match and injection-safe via bound params. This is dialect-sensitive SQL, so
it's tested on **both** legs at the repo level per the dual-dialect rule.

Free-text search (`q`) is *not* dialect-divergent: `lower(col) LIKE %q% ESCAPE '\'`
behaves identically on both. Escape `%` / `_` / `\` in the user's term (one literal
`%` shouldn't widen a colleague's search — accident-class, right-sized to the trust
model). SQLite has no default LIKE escape char, so the explicit `ESCAPE '\'` clause
is required for portability. Test both `%` and `_` literals.

## No index, two-query count — both deliberate at gallery scale

`listGallery` runs the page query + a separate `count()` under the same predicate,
unindexed, ordered by `gallery_published_at`. At the product's scale (an opt-in,
single-org gallery is dozens of rows) this is correct and simplest; a
`(gallery_listed, gallery_published_at)` index and keyset paging are documented
post-v1 follow-ups. The count/items off-by-one under a concurrent un-list is
accepted (self-heals on the next refetch). Skipping the index also kept M8 from
touching `schema.*.ts` / `schema.test.ts` / `drizzle/*`, shrinking cross-branch
integration conflict to near zero — a deliberate trade for a parallel-milestone repo.

## TanStack Query `keepPreviousData` + a "reset the page" effect → spurious resets

The browse view keeps the prior page on screen during paging/search
(`placeholderData: keepPreviousData`). Any effect that *acts on* `data` during that
window sees the **previous** query's values. The snap-to-page-1 effect
(`offset >= data.total → navigate(page:1)`) must gate on **`!isPlaceholderData`**,
or a stale total from the old query can fire a reset mid-navigation. Same root cause
drove clamping the "Showing X–Y of N" range to `total` (else a one-render
"Showing 49–49 of 5" flicker). Rule: **never branch on `data` from a
keepPreviousData query without checking `isPlaceholderData` first.**

Other view gotchas: keep search state in the route search param (shareable /
back-able), debounce typing but apply an **empty** field immediately (don't leave
the grid filtered after the user cleared the box); inline the debounce navigate so
the effect's deps are just the values it reads (avoids a `setSearchParam`
exhaustive-deps churn); make tag-click **merge** the prev search, not replace it,
so clicking a tag mid-search doesn't wipe the query. The route lives at `/gallery`
(top-level — never `/c/`, `/v1/`, `/auth/`, `/api/`, per the SPA routing learning).

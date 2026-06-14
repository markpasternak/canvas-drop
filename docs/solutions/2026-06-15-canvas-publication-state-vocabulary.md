---
title: Canvas publication state + the Publish/Deploy vocabulary split
type: architecture
area: canvases
date: 2026-06-15
---

## What this is

The round that unified the canvas lifecycle vocabulary and added the
`publicationState` field, Unpublish, and the share-requires-published invariant
(plan `2026-06-14-006`, origin brainstorm
`docs/brainstorms/2026-06-14-canvas-vocabulary-and-state-model-requirements.md`).
Read this before touching canvas lifecycle UI/state, the share/gallery
invariants, or the docs site. See also [[content-addressed-draft-publish]] (the
draft/version model underneath) and [[dashboard-spa-patterns]].

## The vocabulary contract (UI vs API)

- **Publish is the only UI verb.** Every user-facing dashboard string that means
  "make content live" says Publish/Published. "deploy" survives ONLY as the
  API/SDK/code-identifier term — `/v1/.../deploy`, `DeployButton`, `useDeploy`,
  `api.deploy*` keep the name on purpose. Do not "fix" this to one word; the split
  is deliberate (UI audience vs agent/CLI audience).
- **Publish vs Make current.** "Publish" creates a NEW version (from the draft or
  uploaded files). Re-pointing the live canvas to an EXISTING version is **Make
  current** (it creates no version). Keeping these distinct keeps "Publish" honest.
- **State words:** a canvas is **Draft → Published → Archived**; the served
  snapshot is **Current**. "Live" is retired as a label. Tabs are
  **Status · Editor · Versions · Settings · Backend · Usage** (the editor tab is
  "Editor", not "Draft" — "Draft" is the working-copy artifact + the lifecycle
  state, not a tab).
- **Header upload action is "New version"** (not "Publish files"), shown on every
  tab including Editor — distinct from the editor bar's "Publish" (which publishes
  the draft). One screen can show both because the labels differ.

## `publicationState` is derived server-side, never stored

- A single pure helper, `publicationState(status, hasCurrentVersion)` in
  `packages/shared/src/db/publication-state.ts`, applies precedence
  **disabled > archived > published > draft**. `deleted` maps to `archived`
  (never surfaced). It's the ONE place the precedence lives.
- Every projection calls it: owner detail + list (`management.ts` `publicCanvas`),
  admin list (`admin.ts`), and the Bearer `/v1` GET (`deploy-api.ts`). No schema
  change, no migration — it's computed at projection time from `status` +
  `currentVersionId`. `cv.status` infers as `string`, so cast `as CanvasStatus`
  at call sites.
- The dashboard mirrors the type locally in `lib/api.ts` (it doesn't import
  `@canvas-drop/shared` at runtime) and renders it via `PublicationBadge`.

## The lifecycle invariants (enforced, with cascade)

- **listed ⟹ shared ⟹ published.** Sharing now requires a published canvas. The
  settings PATCH rejects `shared:true` when not published
  (`409 SHARE_REQUIRES_PUBLISH`).
- **Leaving Published reverts share + gallery.** Both `repo.unpublish` and
  `repo.archive` clear `shared/sharedAt/sharedExpiresAt` AND
  `galleryListed/galleryTemplatable/galleryPublishedAt` in the same guarded write.
  Unpublish also nulls `currentVersionId`; archive keeps it (so unarchive returns
  to Published — but NOT shared; the owner re-shares deliberately). The route view
  spreads must reflect the cleared fields, since `ownedCanvas` returns the
  pre-mutation row.
- **Unpublish** (`POST /:id/unpublish`) is owner-only, guarded to active+published
  (else `409 CANNOT_UNPUBLISH` — a distinct code from the gallery's
  `NOT_PUBLISHED`, because `ApiError.hint` is `HINTS[code] ?? message` and reusing
  the code would surface the gallery-worded hint). Drops live sockets (D-RT-6).
  Admin-`disabled` is deliberately NOT reverted by these (takedown is the admin's,
  restored on enable).

## Gotchas that bite

- **A vocabulary rename is mostly a test-fixture/​assertion churn problem.** Adding
  a required field (`publicationState`) to the `Canvas` type breaks every typed
  fixture; ~12 dashboard test files build canvas-shaped mocks (find them by
  grepping `disabledReason`). The header chips also introduce NEW on-screen text
  ("Shared"/"Private"/"Published"), so existing `getByText(...)` calls collide →
  switch to `getAllByText(...).length`. Strategy: make the code change, run the
  whole dashboard suite, fix the reported collisions — don't try to predict them.
- **The docs site is generated.** `apps/server/src/docs/generated-content.ts` is
  built from `docs/site/**` + `docs/site/_nav.json` by `scripts/build-docs.mjs`;
  CI asserts no drift. To rename a doc: `git mv` the `.md`, update its `_nav.json`
  entry (path/file/title), fix internal links, then run `pnpm docs:build`. Page
  title comes from the first `# H1` (or the nav `title`); slug/path from `_nav.json`.
- **Dashboard tests run via `node scripts/test-runner.mjs dashboard`** (jsdom),
  separate from `pnpm test` (server+shared, both dialects in-process). The root
  vitest include is `*.test.ts` only — `.tsx` lives in the dashboard project.

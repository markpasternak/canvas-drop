---
title: Admin content restriction (D-admin-restrict) + post-deploy draft reconciliation
type: architecture
area: auth
date: 2026-06-16
---

Two decisions made during a live testing/review session, after a user noticed that
(a) a *private* canvas was visible to a logged-in account, and (b) an API deploy
left the editor stuck on "a newer version was published". See also
[[2026-06-13-auth-invariant-checklist]] and [[dual-dialect-drizzle-seam]].

## D-admin-restrict: admins get no content bypass on canvases they don't own

**What changed.** `decideCanvasAccess` (`apps/server/src/canvas/authorization.ts`)
used to allow `owner OR admin` full access to any canvas at step 3. It now allows
**owner only**. A non-owner admin falls through to the per-rung checks and is
treated as an ordinary org member:

- non-owned `private` → **404**; non-owned unlisted `specific_people` → **404**
- `whole_org` / `public_link` → reachable as any member would be
- a password-protected rung **prompts the admin too** — no password bypass on a
  canvas it doesn't own (only the owner is never prompted)

The final boundary (after a follow-up): **an admin is fully like any other member
for canvases it doesn't own.** Beyond the content path, this also locked the *owner
management/editor surface* — `ownedCanvas` in `management.ts` AND `draft-api.ts` is
now **owner-only** (was owner-OR-admin), so a non-owner admin can't view/edit a
draft, preview, deploy, change settings, archive, or delete someone else's canvas
(all `404`). The admin's delete-a-disabled-canvas shortcut was removed with it (a
disabled canvas now can't be deleted by anyone until re-enabled). `hub.dropGatedNonOwners`
now drops admin sockets too (they face the gate). The admin dashboard's overview
lists (top-canvases, AI-spend) no longer deep-link to `/canvases/$id` since that page
404s for admins; moderation is the all-canvases table's inline actions.

**Why it's safe / correct.** The original "private canvas visible to any logged-in
user" report was an admin viewing via the blanket bypass — *intended* under the old
spec but not what the org wanted. The change makes the code match plan **R3**
("owner/admin always reach *their own* canvas") and follows the existing M7
precedent that admins are **not** exempted from the `disabled` branch. Cross-owner
admin power is now strictly the **dedicated admin routes** (the all-canvases list +
disable/enable/restore via `adminRepository`), never content, the owner management
surface, the runtime API, or realtime.

**The trap (why this needed a spec amendment, not just a code edit).** A
`/ce-code-review` flagged it **P0**: `BUILD_BRIEF §12.0 #3` still read "reachable
only by its owner **or an admin**", so the code now *contradicted the locked spec*.
The fix was to amend the authoritative text everywhere it appears — otherwise a
future agent reading the spec would "restore" the bypass:
- `BUILD_BRIEF.md §12.0 #3`, `README.md`, `docs/site/self-hosting/security-model.md`,
  `docs/site/authoring/sharing.md` (then `pnpm docs:build` to regenerate
  `generated-content.ts` / `/llms.txt`)
- the access-ladder plan (flowchart `OWN{owner?}`, U3 approach, R23)

**Enforcement is one seam, three consumers.** `decideCanvasAccess` is called by the
content middleware (`app.ts`), the runtime API (`canvas-api.ts`), and the realtime
hub (`revalidateCanvas`, `hub.ts`). Changing the table fixed all three at once;
separately, the owner management/editor surface is gated by `ownedCanvas` (its own
owner check in `management.ts` + `draft-api.ts`), which had to be locked too — the
decision table alone does NOT cover the dashboard editor/draft/preview/settings
routes. Regression tests live at the decision-table level (`authorization.test.ts`)
**and** the route level (`canvas-api.test.ts`, `canvas-realtime.test.ts`,
`management.test.ts`) — the route tests guard against a re-added bypass that a unit
test alone wouldn't catch.

**Two enforcement seams, not one.** The lesson worth keeping: "admins can't reach
others' content" needed BOTH `decideCanvasAccess` (public serve / runtime / realtime)
AND `ownedCanvas` (dashboard management/editor). The first guards what *visitors*
hit; the second guards what the *owner UI* hits. Restricting only the first leaves
admins able to read/edit drafts through the editor.

## Post-deploy draft reconciliation: the editor must show what was deployed

**The bug.** Deploying via the API created a new current version (v2), but the
editor still showed the old draft with "Unpublished changes" + "A newer version was
published". Cause: the deploy engine's reconciliation flagged the draft **stale**
whenever it was *non-empty* — but the editor seeds a draft from the current version
on open, so a draft that merely mirrors the previous version is a non-empty
**untouched working copy**, not held edits.

**The fix** (`apps/server/src/deploy/engine.ts`). Decide by what the draft holds
**relative to its base version**, not whether it's non-empty:

- no draft → seed it to the just-published version
- draft manifest == its base version's manifest → no real edits → `resetToBase` to
  the new version (editor now shows the deploy, `stale=false`, `dirty=false`)
- draft manifest != base → genuine held edits → `markStale` (preserve + show the
  banner). No base / pruned base + content → treat as edits (preserve, conservative)

The manifest comparison (content-hash equality) is now one shared helper,
`manifestsEqual` in `canvas/manifest.ts`, reused by the engine and the editor's
`isDirty` (draft vs live) so the two can't drift.

**Reusable lesson.** "Has the user edited?" for a draft means *draft vs its base
version*, never *draft is non-empty* (the editor always seeds content) and never
*draft vs the new live version* (a fresh deploy always differs).

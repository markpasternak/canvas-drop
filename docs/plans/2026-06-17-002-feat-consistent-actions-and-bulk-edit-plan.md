# Plan: Consistent action controls + bulk multi-select (Your canvases)

- **Date:** 2026-06-17
- **Status:** in progress
- **Branch:** `claude/nice-hawking-097bxm` (single branch, single round — autonomous full-scope)
- **Owner ask:** Make the "do something to a thing" controls consistent and best-practice across every
  surface (gallery, Your-canvases list, admin tables, versions, canvas detail), and add multi-edit
  (bulk actions) where it makes sense — starting with bulk-archiving canvases.

## Problem

Every action surface renders its controls a different way (audited 2026-06-17):

- **Your canvases** (`routes/index.tsx`): primary link + a one-off inline `RowOverflowMenu` (kebab).
- **Gallery cards** (`routes/gallery.tsx`): a visible row of `Button`/`CopyButton`.
- **Admin canvases** (`AdminCanvasTable.tsx`): a single status `Button`; open/owner are bare text links.
- **Admin users** (`AdminUserTable.tsx`): three side-by-side `Button`s.
- **Versions** (`routes/canvas.versions.tsx`): two inline `Button`s.

Root cause: **there is no shared menu/overflow primitive.** `RowOverflowMenu` is inlined in one route and
lacks WAI-ARIA menu keyboard nav. There is also **no bulk selection anywhere** — every action is per-row.

Best-practice target (Carbon, PatternFly, current data-table UX guidance): one **primary action visible +
an overflow "kebab" menu** for the rest on spacious rows/cards; a **pure overflow menu** on dense tables;
and a **contextual bulk-action toolbar** that appears only when rows are selected.

## Decisions (confirmed with owner)

1. **Pattern:** "primary + kebab everywhere" via a single shared `ActionMenu` component. Dense admin
   tables use the same component as a pure overflow menu (best practice for dense rows); spacious
   list rows / cards keep a visible primary + kebab. Settings keeps explicit labeled buttons.
2. **Bulk multi-select scope:** **Your canvases only** (owner list). Active: bulk Archive + Delete.
   Archived: bulk Unarchive + Delete. Delete is behind a hold-to-confirm dialog. Admin tables and
   admin users are out of scope this round.

## Architecture / invariants

- **No backend or MCP changes.** Bulk = the existing per-canvas `archive` / `unarchive` / `delete`
  endpoints applied N times (the page only ever shows one page of ids). Each call already runs
  `requireOwned` + emits its audit event. No new owner capability is introduced, so the agent-native
  **MCP parity rule holds with zero new tools** (`archive_canvas` / `unarchive_canvas` /
  `delete_canvas` already exist; an agent bulk-archives by calling the tool per id).
- Adding a per-row **Delete** to the Your-canvases overflow menu (it only lived in Settings before)
  brings single-row parity with the new bulk action. It is **not** a new owner capability: the MCP
  server already exposes `delete_canvas` (`apps/server/src/mcp/server.ts`), so agent-native parity
  holds without any MCP change — same for the row-level archive/unarchive (`archive_canvas` /
  `unarchive_canvas`).

## Units

### U1 — `ActionMenu` shared primitive (`components/ActionMenu.tsx`)
Generalize `RowOverflowMenu` into a reusable, accessible menu-button:
- Trigger: `IconButton` with a kebab (`DotsThreeVertical`) or caret, `aria-haspopup="menu"`,
  `aria-expanded`. Configurable `label`, `align` (`end` default), `size`.
- `ActionMenuItem` children (button or anchor): optional leading icon, `danger` tone, `disabled`
  (+ disabled `title`); selecting runs `onSelect` then closes the menu. Provided via context so callers
  don't thread a `close` callback.
- A11y per WAI-ARIA menu-button: open focuses first item; ArrowUp/Down roving focus; Home/End;
  Escape closes + restores focus to trigger; Tab/outside-pointer closes. `role="menu"`/`menuitem`.
- Reuse the existing popover styling (`--shadow-popover`) and `rowMenuItemClass` look.

### U2 — Bulk lifecycle mutations (`lib/mutations.ts`)
`useBulkArchive()`, `useBulkUnarchive()`, `useBulkDelete()`:
- Input `ids: string[]`; run `Promise.allSettled` over the existing `api.*` calls.
- Return `{ succeeded: string[]; failed: string[] }`; `onSettled` invalidates `keys.canvases`.

### U3 — Selection + bulk bar on Your canvases (`routes/index.tsx`, `components/CanvasList.tsx`)
- `CanvasRow` gains an opt-in `selectable` mode: a leading checkbox (`selected` + `onSelectChange`),
  not shown when not selectable (gallery/other callers unaffected).
- New `components/BulkActionBar.tsx`: sticky contextual toolbar shown only when ≥1 selected —
  "N selected", select-all/clear, and scope-appropriate bulk buttons (Archive/Delete or
  Unarchive/Delete). Destructive bulk routes through `ConfirmDialog` (hold-to-confirm for delete).
- `index.tsx` owns selection state (a `Set<string>`), a header "select all on page" checkbox,
  clears selection on page/scope/filter change and after a successful bulk op, and reports
  aggregate success/failure via toast.

### U4 — Adopt `ActionMenu` everywhere
- `index.tsx`: replace `RowOverflowMenu` with `ActionMenu`; add Delete to the menu.
- `gallery.tsx`: footer right = `ActionMenu` (Copy link, Open in new tab); templatable cards keep a
  visible "Make a copy" primary before the kebab.
- `AdminCanvasTable.tsx`: actions cell = pure `ActionMenu` (Open canvas, Copy link, View owner; +
  Disable/Enable/Restore by status; Disable opens the existing `TakedownDialog`).
- `AdminUserTable.tsx`: governance actions (Grant/Revoke public, Promote/Demote, Block/Unblock) move
  into a per-row `ActionMenu`; self-protection disables the relevant items. Canvas count + View stay.
- `canvas.versions.tsx`: visible "Make current" (when not current) + `ActionMenu` ("Edit this version").
- Delete the now-dead inline `RowOverflowMenu`; route `rowMenuItemClass` usage through `ActionMenuItem`.

### U5 — Tests
- `action-menu.test.tsx`: open/close, Escape, outside-click, item select closes, arrow-key roving
  focus, aria attributes, disabled item not actionable.
- `bulk-actions.test.tsx`: select rows → bar with count; select-all; bulk archive calls api per id +
  toast; delete requires hold-confirm; selection clears after success.
- Update existing tests that assert the old markup (`gallery.test`, `admin*.test`,
  `your-canvases-filters.test`, `versions.test`) for the new menu structure.

## Gates
`pnpm lint && pnpm typecheck && pnpm test` (both dialects) green; `/ce-code-review`; then commit + push
to `claude/nice-hawking-097bxm`. No PR unless asked.

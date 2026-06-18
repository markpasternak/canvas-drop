# Plan — Editorial Creator OS rebrand: remaining work

**Status:** ready to execute · **Branch:** `feat/rebrand-readiness` (worktree `../canvas-drop-rebrand`)
**Constraints:** commit per unit to this branch; gates green every unit (`pnpm typecheck && pnpm lint && pnpm test` both dialects, `pnpm build`); **do NOT merge to main; do NOT push to origin** — Mark gives the final yes. Trust model = trusted-org self-host.
**Source:** continues `docs/plans/2026-06-17-003-feat-editorial-creator-os-rebrand-plan.md`; progress in `docs/brainstorms/2026-06-18-rebrand-run-log.md`.

## Already done (do not re-plan)
P1 brand/token foundation + teal/warm/navy reskin + single-source ramp (dashboard + all server surfaces) + logo; P2 Newsreader serif; P3 a11y slice; P6 motion + focus-ring; P5 voice; code-review fixes; merged main (gallery-first `CanvasCard` + list/grid `ViewToggle` already shipped); dev sample-canvas seeding.

## Dependency order
P4 (U1–U4) → P3 consolidation (U5–U9) → P6 remainder (U10–U12) → P7 marketing (U13–U14) → P8 flow (U15–U18). P3 primitives may be used by later units but are not blockers for P4. Each unit is an atomic commit.

---

## P4 — Right detail rail (the headline)

### U1. Selection state for the detail rail
**Goal:** A single "focused" canvas on the Your-canvases route, distinct from multi-select. Clicking a row/card body (not an interactive child) focuses it; URL-driven (`?selected=<id>`) so it's shareable/back-able and survives list/grid view + filters.
**Files:** `apps/dashboard/src/routes/index.tsx`, search-param schema; `apps/dashboard/src/test/your-canvases-detail.test.tsx` (new).
**Approach:** add `selected` to the route search schema; a `setSelected(id)` that patches search (preserve view/scope/filters/page). Wire `CanvasRow`/`CanvasCard` body click + keyboard (Enter) to focus, guarding `isInteractiveTarget` (reuse existing helper) so Open/checkbox/kebab still work. Multi-select checkboxes unchanged.
**Test scenarios:** clicking a card body sets `?selected=<id>` without navigating; clicking Open/checkbox/kebab does NOT focus; Enter on a focused row focuses; selecting another updates the param; invalid `?selected` is ignored.
**Verification:** URL reflects selection; existing list/grid/multi-select tests still green.

### U2. `DetailPanel` component (presentational)
**Goal:** The "living object" panel for one canvas.
**Files:** `apps/dashboard/src/components/DetailPanel.tsx` (new) + `apps/dashboard/src/test/detail-panel.test.tsx` (new).
**Approach:** props = `{ canvas: CanvasListItem | null }`. Render: `CanvasCover` (hero), serif title, `PublicationBadge` + `AccessBadge`, primary actions (Open ↗ external, Share → `/canvases/$id/share`, Duplicate → opens `CloneDialog`, More → `/canvases/$id`), a details list (Access via `accessRungLabel`, Visibility, Status, Edited `relativeTime`, Created `fullTime`), and a "Recent activity" block (from `lastDeploy` + `updatedAt`; full feed deferred). `null` → quiet empty state ("Select a canvas to see details"). Reuse exported helpers only; no duplication of row internals.
**Test scenarios:** renders title/status/access/dates for a canvas; Open uses `canvas.url`; Share links to the share route; `null` renders the empty state; never-deployed canvas shows "Continue setup" instead of Open.
**Verification:** component renders in isolation; a11y (region label, headings) present.

### U3. Two-pane layout + responsive
**Goal:** Show `DetailPanel` beside the library; responsive collapse.
**Files:** `apps/dashboard/src/routes/index.tsx`; optionally `apps/dashboard/src/components/Drawer.tsx` (new, or reuse `Dialog` trap).
**Approach:** wrap library + rail in a 2-col grid at `xl` (rail ~340px, sticky); below `xl` the rail becomes a slide-in drawer opened on selection (reuse `Dialog` focus-trap + Escape + scrim + the `cd-anim-*` motion); below `sm` a bottom sheet. Library keeps full width when nothing is selected on `xl`. Does not disturb bulk-action bar / pagination.
**Test scenarios:** `xl` shows the rail inline when a canvas is selected; below `xl` selection opens the drawer (focus moves in, Escape closes, focus restored); clearing selection hides rail/drawer; bulk-action bar still works with a selection active.
**Verification:** screenshots at xl + lg + mobile; no console errors; existing route tests green.

### U4. Wire actions + polish the rail
**Goal:** The rail's actions are live and match row behavior.
**Files:** `apps/dashboard/src/components/DetailPanel.tsx`, `index.tsx`.
**Approach:** Duplicate opens the shared `CloneDialog`; More/Details navigates to `/canvases/$id`. Selecting persists (last-selected) within the session. Cover uses the same `previewCoverUrl` thumb as the rows.
**Test scenarios:** Duplicate opens the clone confirm; details navigation works; cover falls back to generative when no preview.
**Verification:** parity with row actions; gates green.

---

## P3 — Primitive consolidation

### U5. Shared variant/size vocabulary
**Goal:** One `Variant`/`Tone`/`Size` source of truth.
**Files:** `apps/dashboard/src/components/variants.ts` (new); `Button.tsx`, `IconButton.tsx`, `Badge.tsx`, `Surface.tsx` (InlineNotice), `ActionMenu.tsx`.
**Approach:** export shared unions + size→height map (`--control-*`). Standardize on `variant` (migrate `IconButton`/`Badge`/`InlineNotice` `tone`→`variant` or alias). Keep public behavior identical.
**Test scenarios:** existing Button/IconButton/Badge tests pass unchanged; a render test per variant/size.
**Verification:** no visual change; gates green.

### U6. `SegmentedControl` primitive
**Goal:** Replace the 4–5 hand-rolled segmented controls; bake `aria-pressed`/roles once.
**Files:** `apps/dashboard/src/components/SegmentedControl.tsx` (new) + test; migrate `app-layout.tsx` (ThemeSwitch + section nav), `PublishBar.tsx` (Mode/Pane), `index.tsx` (ScopeToggle + ViewToggle), `new.tsx`.
**Approach:** items = `{value,label,icon?}`; one active treatment (sunken track + raised chip); `aria-pressed` baked in; controlled value/onChange.
**Test scenarios:** renders options; active item has `aria-pressed=true`; click/keydown fires onChange; migrated sites keep their existing test assertions (update queries to the primitive).
**Verification:** the 5 sites look/behave identically; a11y correct; gates green.

### U7. `SearchInput` primitive + shared input recipe
**Goal:** One search input (5 copies today) on one `inputControl` string.
**Files:** `apps/dashboard/src/components/SearchInput.tsx` (new) + `apps/dashboard/src/lib/input-styles.ts` (new); migrate `index.tsx`, `admin.canvases.tsx`, `gallery.tsx`, `admin.users.tsx`, `admin.settings.tsx`; route `Field`/`SlugField`/`PasswordField` through `inputControl`.
**Test scenarios:** renders with icon + label; typing fires onChange; `Field` still renders/validates; migrated routes' search tests pass.
**Verification:** all search inputs identical; gates green.

### U8. `TabNav` primitive
**Goal:** One tab nav (2 implementations today).
**Files:** `apps/dashboard/src/components/TabNav.tsx` (new) + test; migrate `AdminHeader.tsx` + `CanvasDetail.tsx`.
**Approach:** TanStack `activeProps`/`aria-current`; consistent padding + active underline; scroll-edge fade for overflow (addresses the 7-tab clip).
**Test scenarios:** active tab has `aria-current`; renders all tabs; overflow fade present; admin + canvas-detail nav still navigate.
**Verification:** both tab bars identical; gates green.

### U9. `DataTable`, `Tag`, `CodeBox`
**Goal:** Remove the byte-identical admin-table chrome + ad-hoc chips/code boxes.
**Files:** `apps/dashboard/src/components/DataTable.tsx`, `Tag.tsx`, `CodeBox.tsx` (new) + tests; migrate `AdminCanvasTable.tsx`, `AdminUserTable.tsx`, tag chips (`CanvasList`/`gallery`), code boxes (`ApiKeyReveal`, `new.tsx`).
**Test scenarios:** DataTable renders header/rows/empty; Tag renders display + clickable; CodeBox renders + copy; admin tables keep their existing assertions.
**Verification:** admin tables unchanged visually; gates green.

---

## P6 — Polish remainder

### U10. Mobile menu focus-trap + Escape
**Goal:** The app-layout mobile section menu traps focus + closes on Escape with focus restore.
**Files:** `apps/dashboard/src/app-layout.tsx` + test.
**Approach:** reuse the `Dialog` focus pattern (move focus on open, Escape to close, restore on close).
**Test scenarios:** opening moves focus into the menu; Escape closes + restores focus; Tab cycles within.
**Verification:** keyboard-only nav works; gates green.

### U11. Reduced-motion feedback
**Goal:** Preserve essential feedback under reduced-motion.
**Files:** `apps/dashboard/src/components/Button.tsx`, `HoldButton.tsx`, `base.css` + tests.
**Approach:** under `prefers-reduced-motion`, the button spinner shows a static "Working…"/label; HoldButton uses a discrete countdown or stays operable (the JS timer already is). Don't blanket-suppress the hold feedback.
**Test scenarios:** reduced-motion render shows a textual busy cue; HoldButton still completes.
**Verification:** gates green; manual reduced-motion check.

### U12. Overlay exit motion + one hover model
**Goal:** Two-phase enter/exit for Dialog/menu/toast; one "a canvas" hover model.
**Files:** `Dialog.tsx`, `ActionMenu.tsx`, `Toast.tsx`, `base.css`, `lib/row-styles.ts`, `CanvasList.tsx`/`gallery.tsx`.
**Approach:** add data-state exit keyframes (delay unmount ~150ms); codify one hover treatment for cards vs rows (cards lift; rows tint+border) in `row-styles.ts` and apply consistently.
**Test scenarios:** dialog/menu/toast unmount after the exit anim (fake timers); reduced-motion path instant; hover classes applied uniformly.
**Verification:** smooth open/close; gates green.

---

## P7 — Marketing "Committed" bold landing (no image regen)

### U13. Self-host Newsreader server-side
**Goal:** The signed-out landing can use Newsreader without a CDN (no phone-home).
**Files:** `apps/server/src/http/` (font asset route or static serve), `apps/dashboard/public/` fonts or a shared font dir; landing/legal/error `@font-face`.
**Approach:** serve the Newsreader woff2 (from `@fontsource-variable/newsreader`) via the existing brand-asset route; add `@font-face` to the server pages' CSS; `--font-serif` available server-side. Keep Geist as-is.
**Test scenarios:** the font asset route returns the woff2 with correct content-type + caching; landing HTML references the self-hosted font (no external URL).
**Verification:** no external font request on the landing; gates green.

### U14. Landing Committed treatment
**Goal:** Drenched teal hero + amber second accent + editorial serif, matching the approved bold preview. **Do NOT regenerate the tour/preview/og images** (Mark).
**Files:** `apps/server/src/http/landing-page.ts`; amber from `MARKETING_ACCENT` (shared).
**Approach:** serif hero headline with the italic-accent clause; drenched teal→navy hero band with amber glow; amber eyebrow/CTA; per-primitive tints; CTA band. Pull amber from `MARKETING_ACCENT` (don't inline). Keep the existing tour screenshots untouched.
**Test scenarios:** landing renders the serif hero + amber accent; uses `MARKETING_ACCENT` (no inline amber hex); no indigo (existing parity scan); existing landing tests pass.
**Verification:** screenshot the signed-out landing (light); gates green.

---

## P8 — Flow & efficiency

### U15. Command palette (⌘K)
**Goal:** Keyboard-first navigation/actions.
**Files:** `apps/dashboard/src/components/CommandPalette.tsx` (new) + test; mount in `app-layout.tsx`.
**Approach:** ⌘K/Ctrl-K opens; fuzzy list of commands (go to Canvases/Gallery/Admin/Docs, Create canvas, jump to a canvas by title, toggle theme); reuse Dialog trap + motion. No new heavy dep unless warranted (small local matcher).
**Test scenarios:** ⌘K opens; typing filters; Enter runs the command/navigates; Escape closes; arrow keys move; a11y combobox roles.
**Verification:** palette works; gates green.

### U16. ⌘↵ publish + shortcut cheatsheet
**Goal:** Publish from the editor via ⌘↵; a `?` cheatsheet.
**Files:** `canvas.editor.tsx`/`PublishBar.tsx`, `apps/dashboard/src/components/Shortcuts.tsx` (new) + test; link from user menu.
**Test scenarios:** ⌘↵ triggers publish when a draft is dirty; `?` opens the cheatsheet; Escape closes.
**Verification:** gates green.

### U17. Slug-aware canvas lookup
**Goal:** Pasting `/canvases/<slug>` resolves instead of 404.
**Files:** `apps/dashboard/src/lib/api.ts`, `routes/canvas.tsx` + test.
**Approach:** when `findById` 404s and the id looks slug-shaped, try a slug lookup → redirect to the canonical `/canvases/<uuid>`.
**Test scenarios:** slug URL redirects to the uuid route; unknown slug still 404s; uuid path unchanged.
**Verification:** gates green.

### U18. JS-canvas in-editor preview
**Goal:** Preview scripted drafts in the editor (currently hard-gated off).
**Files:** `canvas.editor.tsx`, `DraftPreview.tsx` + test.
**Approach:** authenticated same-origin draft preview frame (or a "Run preview" affordance) for JS canvases, within the existing draft/sandbox constraints.
**Test scenarios:** scripted draft shows a preview affordance; static drafts unchanged; sandbox attributes correct.
**Verification:** gates green; manual editor check.

---

## Risks & notes
- **U3 two-pane** is the riskiest (route already carries list/grid + multi-select + bulk + pagination). Keep rail additive; rail hidden when nothing selected; never disturb bulk/pagination. Screenshot-verify.
- **P3 migrations** must update test queries that target old markup; keep behavior identical (no visual change is the success bar).
- **U13 fonts**: confirm `@fontsource-variable/newsreader` ships woff2 and licensing allows self-serving (OFL — yes).
- **No merge/push.** Mark approves the final step.

## Definition of done
All units committed to `feat/rebrand-readiness`; each gate green; `/ce-code-review` before declaring complete with real findings fixed; run log updated. Await Mark's yes for merge/push.

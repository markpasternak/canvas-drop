---
title: "feat: Flat redesign of the canvas detail surface + all tabs"
date: 2026-06-18
type: feat
branch: feat/rebrand-readiness
status: ready
depth: standard
---

# feat: Flat redesign of the canvas detail surface + all tabs

Bring the per-canvas detail surface — the `/canvases/$id` shell and every tab
(Overview, Editor chrome, Share, Versions, Backend/Capabilities, Usage, Settings) —
to the **flat Editorial Creator OS** look already shipped on the Your-canvases list
and the right detail rail. Today these surfaces are built from stacked rounded
"boxy" section cards; the owner wants flat sections (hairline dividers, serif section
titles, generous spacing), restrained color accents (teal primary CTA, concept colors
for state), and reuse of the primitives we already flattened — not new abstractions.

**Constraints:** presentational only — no route, data, or backend change. Commit per
unit to `feat/rebrand-readiness`; gates green each unit (`pnpm format` first, then
`typecheck`, `lint`, dual-dialect `test`, `build`). **No merge to main, no push** —
Mark gives the final yes. Trust model = trusted-org self-host.

**Reference for the target feel (already shipped, do not re-plan):**
`apps/dashboard/src/routes/index.tsx` (flat list), `apps/dashboard/src/components/DetailPanel.tsx`
(the chrome-less `aside` + `actionBase`/`primaryClass`/`secondaryClass` button pattern),
`DESIGN.md` (§Color, §Typography, §Elevation, §"Patterns to avoid").

---

## Problem frame

Every canvas tab renders its content inside `Panel` / `SettingsSection.Section`
cards — `rounded-xl border border-border bg-surface p-5 shadow-[var(--shadow-panel)]`.
Stacked, they read as nested boxes: a card per section, sometimes a card inside the
shell card. The owner's words: *"redesign the whole canvas setting and all tabs based
on the more flat look… I don't like all these rounded boxes in the setting sections."*
DESIGN.md already calls these out as slop tells ("identical card grids", over-boxed
chrome) and prescribes "paper & objects": quiet flat chrome, color and energy in the
content, serif section titles, hairline edges.

The boxiness traces to a **small shared-primitive set**, so the fix is high-leverage:

| Source primitive | File | Renders | Consumed by |
|---|---|---|---|
| `Section` (titled settings card) | `components/SettingsSection.tsx` | wraps `Panel`, sans `text-sm` heading | Settings (5), Share (6), Backend (1), **admin** |
| `Panel` (generic card) | `components/Surface.tsx` | `rounded-xl border bg-surface shadow p-5` | Overview (3), Versions (2), Usage (2) — **and** onboarding/new/gallery/index/admin.settings |
| `CanvasDetailChrome` (the shell header) | `components/CanvasDetail.tsx` | `rounded-xl … shadow` card holding title + URL bar + `TabNav` | `routes/canvas.tsx` |
| `WorkspacePane` + `PaneHeader` | `components/Surface.tsx` | `rounded-xl … shadow` panes | Editor (`canvas.editor.tsx`), `OnPageEditor`, `DraftPreview` |
| `CollapsibleSection` | `components/CollapsibleSection.tsx` | `rounded-xl … shadow` disclosure | admin overview (`routes/admin.tsx`) |

---

## Requirements

- **R1** Canvas tabs read flat: section content sits on the page in hairline-divided
  bands with serif section titles + generous spacing — no nested rounded card per section.
- **R2** Reuse existing flat patterns (DetailPanel button classes, Tag/Badge/
  SegmentedControl/TabNav, the concept-color map, serif titles) — no new section abstraction.
- **R3** Restrained color accents: one teal-accent primary CTA per surface; state shown
  via concept colors / status badges, not by re-coloring the whole chrome ("quiet chrome,
  expressive content", DESIGN.md §Color).
- **R4** The detail **shell** (`/canvases/$id` header: title, live-URL row, tab bar) is
  flat and matches the `PageHeader` serif treatment, not a boxed card.
- **R5** The **Editor** keeps its functional 3-pane working layout; only its surrounding
  chrome (panes, headers, notices) is flattened — not a re-layout.
- **R6** Behavior is unchanged everywhere — every existing route test still passes;
  presentational test assertions on removed card classes are updated, not deleted.
- **R7** Light **and** dark themes both verified flat + on-brand (AA contrast holds).

---

## Key technical decisions

- **KTD1 — Flatten via the shared section primitive, not a global `Panel` gut.** Rework
  `SettingsSection.Section` to render flat (serif heading + hairline-divided band) instead
  of wrapping `Panel`. This re-skins Settings, Share, Backend, **and** admin (all consume
  `Section`) in one edit — the leverage Mark confirmed. Leave the generic `Panel` primitive
  **unchanged** so onboarding / new / gallery / index / admin.settings keep their card
  layouts; the three Panel-based canvas tabs (Overview, Versions, Usage) migrate to the flat
  `Section` instead (U3). Rationale: `Panel` is a genuine card used by non-settings surfaces
  the owner did not complain about; gutting it globally is a wider, riskier blast than the
  request warrants.
- **KTD2 — One flat-section idiom, reused.** A flat section = serif heading (`font-serif`,
  ~`text-section` per DESIGN, 500) + optional muted description + content, separated from the
  previous section by a top hairline + vertical rhythm (`border-t border-border pt-6`, none on
  the first). Mirrors DetailPanel's `SectionTitle` + `divide-y` idiom and the flat list header.
  Danger sections drop the red box for a `text-danger` serif heading; the destructive `Button`
  carries the danger tone (DESIGN: no side-stripe accent borders).
- **KTD3 — Shell as a flat header, not a card.** `CanvasDetailChrome` becomes a flat header:
  serif `h1` (matching `PageHeader`), a flat live-URL row (keep copy/open affordances), and
  `TabNav` as an underline tab bar with a single bottom hairline — no surrounding `rounded-xl`
  card/shadow. `TabNav` already renders `aria-current`/active styling; keep it.
- **KTD4 — Editor chrome flattened, layout intact.** `WorkspacePane`/`PaneHeader` lose the
  `rounded-xl … shadow` card treatment for flat bordered panes (hairline seams between the file
  tree / asset preview / live preview); the 3-pane grid, file tree, autosave, and publish bar
  are untouched. Because `OnPageEditor`/`DraftPreview` also use `WorkspacePane`, the editor
  flattens consistently.
- **KTD5 — Color accent is the existing teal primary pattern.** Adopt DetailPanel's
  `primaryClass` (accent-filled) for the one primary CTA on each tab and `secondaryClass`
  (flat hairline) for secondaries, rather than inventing button styles. State/badges keep the
  shared `concept-colors` + `Badge`/`StatusBadge`.
- **KTD6 — External research skipped (settled internal pattern).** The authoritative reference
  is the already-shipped flat list + rail + DESIGN.md; flat-settings prior art (Linear/Vercel/
  Lovable) informed the single-column hairline-band idiom but adds nothing the internal pattern
  doesn't already encode. Noted per the user's "research if you need to — but you should have
  the context."

---

## Implementation units

Dependency order: **U1 → U3** (U3 reuses U1's flat Section); **U2, U4, U5** independent of
each other and of U1; **U6** is the final accent+verification sweep over all of them.

### U1. Flatten the settings-section primitive

**Goal:** Rework the titled-section card into a flat hairline-divided band, re-skinning
Settings, Share, Backend, and admin in one edit (R1, R2; KTD1, KTD2).
**Dependencies:** none.
**Files:** `apps/dashboard/src/components/SettingsSection.tsx`; touches (no structural change)
`apps/dashboard/src/routes/canvas.settings.tsx`, `canvas.share.tsx`, `canvas.capabilities.tsx`,
`apps/dashboard/src/routes/admin.tsx`; tests `apps/dashboard/src/test/settings.test.tsx`,
`share.test.tsx`, `capabilities.test.tsx`, `admin.test.tsx`.
**Approach:** `Section` no longer wraps `Panel`. Render a flat `<section>`: serif heading
(`font-serif` + DESIGN section step, 500 weight; `text-danger` when `tone="danger"`), optional
muted description, then the children. Separate stacked sections with a top hairline + padding
(`border-t border-border pt-6`) — first section flush; keep `scroll-mt-20` for section-nav jumps.
Keep `Row`/`RowDivider` exports and their signatures. No red card for danger — heading goes
`text-danger`, destructive buttons already carry danger tone.
**Patterns to follow:** `DetailPanel.tsx` `SectionTitle` + `divide-y`; `PageHeader` serif.
**Test scenarios:**
- Settings/Share/Backend routes still render every section heading + control by role/text
  (behavior unchanged) — existing tests pass.
- A `Section` wrapper renders **no** `rounded-xl`/`shadow` card class (assert the flat band).
- `tone="danger"` renders the heading in the danger color and still renders its destructive
  control; no red bordered box.
- Update any assertion in the four test files that keyed on the old card classes.
**Verification:** Settings/Share/Backend tabs show flat divided sections, no nested cards; admin
governance sections inherit the same flat look; gates green.

### U2. Flatten the detail shell (header + URL row + tab bar)

**Goal:** Replace the boxed shell header with a flat serif header + underline tab bar (R4; KTD3).
**Dependencies:** none.
**Files:** `apps/dashboard/src/components/CanvasDetail.tsx` (`CanvasDetailChrome`);
`apps/dashboard/src/routes/canvas.tsx` (consumer, verify spacing); test
`apps/dashboard/src/test/canvas-status.test.tsx` (and any chrome/title assertions).
**Approach:** Drop the `rounded-xl border bg-surface shadow` wrapper. Render: a serif `h1`
title (match `PageHeader`'s `font-serif text-h1` treatment) with the optional status `badge`
and `actions`; a flat live-URL row (keep the mono URL link + `CopyButton` + open `IconLink`,
but as a quiet hairline row, not a sunken pill-in-a-card); `TabNav` as an underline tab bar
with a single `border-b border-border`. Preserve loading skeletons.
**Patterns to follow:** `Surface.tsx` `PageHeader`; the editor screenshot's tab row (minus the card).
**Test scenarios:**
- Title, status badge, and tab links still render and navigate (active tab marked
  `aria-current`) — existing tests pass.
- The chrome wrapper renders no `rounded-xl`/`shadow` card class.
- Live-URL copy + open affordances still present and labelled.
**Verification:** Shell reads as a flat editorial header with an underline tab bar; gates green.

### U3. Migrate the Panel-based canvas tabs to flat sections

**Goal:** Overview, Versions, Usage stop using raw `Panel` cards and read flat like the rest (R1; KTD1).
**Dependencies:** U1 (reuses the flat `Section`).
**Files:** `apps/dashboard/src/routes/canvas.overview.tsx`, `canvas.versions.tsx`,
`canvas.usage.tsx`; tests `apps/dashboard/src/test/versions.test.tsx`, `usage.test.tsx`,
plus the overview assertions in `your-canvases-detail.test.tsx`/`canvas-status.test.tsx` if any.
**Approach:** Replace each `<Panel>` with a flat `Section` (or, where a block has no title, a
flat `<section>` with the same hairline-band rhythm). Keep `MetaGrid`/`MetaItem`/`InlineNotice`
(notices stay lightly rounded — they are intentional callouts, not section cards). Do **not**
modify the shared `Panel` primitive — onboarding/new/gallery/index/admin.settings keep it.
**Patterns to follow:** U1's flat `Section`; `DetailPanel` details list for stat rows.
**Test scenarios:**
- Overview/Versions/Usage still render their data (version rows, usage stats, metadata) by
  role/text — existing tests pass.
- No `<Panel>`-derived `rounded-xl` card remains in these three routes.
- `MetaGrid` stats still render with `tabular-nums`.
**Verification:** All three tabs flat; `Panel` still imported only by the non-canvas surfaces;
gates green.

### U4. Flatten the editor chrome (panes kept functional)

**Goal:** Soften the editor's 3-pane chrome to flat panes without re-laying-out the editor (R5; KTD4).
**Dependencies:** none.
**Files:** `apps/dashboard/src/components/Surface.tsx` (`WorkspacePane`, `PaneHeader`);
`apps/dashboard/src/routes/canvas.editor.tsx` (editor-local rounded notices/boxes); verify
`apps/dashboard/src/components/OnPageEditor.tsx`, `DraftPreview.tsx` (also use `WorkspacePane`);
tests `apps/dashboard/src/test/editor.test.tsx`, `onpage-editor.test.tsx`,
`editor-dialog-no-freeze.test.tsx`.
**Approach:** `WorkspacePane` → flat bordered pane (drop `rounded-xl` + `shadow-[var(--shadow-panel)]`;
keep `overflow-hidden`, `min-h-0`, border seams between panes). `PaneHeader` stays a hairline-bottomed
strip (already close — drop any raised/rounded feel, keep the label + actions). Flatten the
editor-local "No HTML page" notice / any `rounded-xl` boxes to `InlineNotice`/flat rows. Leave the
3-pane grid, `FileTree`, autosave, `PublishBar`, and preview wiring untouched.
**Test scenarios:**
- Editor still mounts the 3 panes, file tree, code editor, and preview; publish/autosave
  controls present — existing tests pass (incl. the no-freeze dialog test).
- `WorkspacePane` renders no `rounded-xl`/`shadow` card class.
- `OnPageEditor`/`DraftPreview` still render (shared `WorkspacePane` change is consistent).
**Verification:** Editor reads flatter (flat panes, hairline seams) but works identically; gates green.

### U5. Flatten the admin collapsible disclosure

**Goal:** The admin-overview `CollapsibleSection` card becomes a flat disclosure (R1 consistency; KTD1).
**Dependencies:** none.
**Files:** `apps/dashboard/src/components/CollapsibleSection.tsx`; test
`apps/dashboard/src/test/collapsible-section.test.tsx`; consumer `routes/admin.tsx`.
**Approach:** Drop the `rounded-xl border bg-surface shadow` wrapper for a flat disclosure: the
toggle button stays (caret + serif/sans title), the section separated by a hairline (`border-b
border-border`), body keeps padding (or `flush` divider). Preserve the persisted open/closed
state, `aria-expanded`/`aria-controls`, and the always-rendered region contract.
**Test scenarios:**
- Toggle still expands/collapses; `aria-expanded` flips; persisted state still read/written —
  existing `collapsible-section.test.tsx` passes (update any card-class assertion).
- Wrapper renders no `rounded-xl` card class.
**Verification:** Admin overview disclosures read flat; gates green. *(Admin-only; lowest priority —
ship if time, defer-able without blocking U6 on the canvas tabs.)*

### U6. Accent + polish + cross-tab verification sweep

**Goal:** Confirm restrained teal accents, serif headings, and flat consistency across every tab in
both themes; fix residual drift (R3, R7).
**Dependencies:** U1–U5.
**Files:** small touch-ups across the U1–U5 files as the sweep finds them; no new files.
**Approach:** Audit each tab for: exactly one teal-accent primary CTA (DetailPanel `primaryClass`),
flat `secondaryClass` for the rest; state via concept colors/badges; serif section headings
consistent; no leftover `rounded-xl … shadow` section cards; `InlineNotice` retained for genuine
callouts. Then **Chrome-screenshot-verify** Overview, Editor, Share, Versions, Backend, Usage,
Settings (and admin overview) at `localhost:5173` in **light and dark**.
**Test scenarios:** `Test expectation: none — verification + polish unit.` Re-run the full
dual-dialect suite; all green. Any fix that changes behavior gets a regression test in the
owning unit's test file.
**Verification:** All canvas tabs read flat + on-brand in both themes; full suite + build green;
screenshots captured for Mark's review.

---

## Scope boundaries

**In scope:** the `/canvases/$id` shell + all seven tabs; the shared section/shell/editor-pane/
collapsible primitives they use; admin surfaces that inherit `Section`/`CollapsibleSection`
(consistent re-skin, confirmed).

**Out of scope (non-goals):**
- The generic `Panel` primitive itself, and the **non-canvas** surfaces that use it directly —
  onboarding, new-canvas, gallery, index, admin.settings keep their current cards (KTD1).
- Routes, data, queries, mutations, or any backend/server change — presentational only.
- A functional re-layout of the editor (R5) — chrome flatten only.
- Marketing / landing / signed-out surfaces.

**Deferred to follow-up work:**
- A two-column settings layout (title-left / controls-right, Stripe/Vercel style) — bigger
  layout change; the single-column flat band satisfies the request.
- Globally flattening `Panel` across onboarding/gallery/new if Mark later wants those flat too.

---

## Risks & mitigations

- **Shared-primitive blast radius.** Flattening `Section` re-skins admin; flattening
  `WorkspacePane` re-skins `OnPageEditor`/`DraftPreview`. *Mitigation:* intended + confirmed;
  U6 screenshots admin + editor to confirm nothing regresses. `Panel` left intact to bound it.
- **Tests keyed on card classes.** Some presentational tests may assert `rounded-xl`/`shadow`.
  *Mitigation:* each unit updates (not deletes) those assertions to the flat treatment; behavior
  assertions (text/roles/nav) are preserved as the real contract (R6).
- **Dark-mode contrast on flat surfaces.** Removing card backgrounds puts content on `--canvas`.
  *Mitigation:* U6 verifies AA in both themes; tokens already AA-tuned (DESIGN §Color).
- **Visual regression vs. the approved feel.** *Mitigation:* every UI unit is Chrome-screenshot
  verified against the shipped list/rail look before its commit.

---

## Verification & gates

Per unit, before commit: `pnpm format` → `pnpm typecheck` → `pnpm lint` (exit 0) →
`pnpm test` (both dialects) → `pnpm build`, plus a Chrome screenshot for UI units. After all
units: a full dual-dialect green run, the U6 light+dark screenshot sweep, then **stop for Mark's
yes** — no merge, no push. A mega `/ce-code-review` over the branch before the final yes is
recommended (consistent with the rebrand rounds).

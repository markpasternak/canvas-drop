# Plan — Preview parity: left-rail app shell + colourful elements

**Status:** ready to execute · **Branch:** `feat/rebrand-readiness`
**Constraints:** commit per unit; gates green every unit (typecheck, lint [run `pnpm format` first], dual-dialect test, build); **no merge to main, no push** — Mark gives the final yes. Trust model = trusted-org self-host.
**Reference:** `design/preview.html` (the approved dashboard mock — left rail · center library · right detail rail). The right detail rail already shipped (P4); the colour ramp, serif, covers, and primitives already shipped. This plan adds the **left-rail app shell** and a few **colourful/expressive touches** the preview has that the build doesn't.

## Gap vs preview
The app uses a **top-bar nav** (Canvases/Gallery/Admin + Create/Docs/theme/user). The preview uses a **left sidebar**: a teal logo tile + wordmark, a vertical nav (icon + label, active item in accent-subtle), and the account at the bottom. The preview is also a touch more colourful (teal logo tile, on-brand covers, accent-subtle selected states).

## Dependency order
U1 (AppShell) → U2 (nav content + responsive) → U3 (colourful touches). U1+U2 are the shell; U3 is additive polish.

---

### U1. Left-rail AppShell
**Goal:** Convert the global layout from a top bar to a three-zone shell: a fixed **left rail** (nav) + the routed content (which itself carries the right detail rail on the canvases route). Matches `design/preview.html`.
**Files:** `apps/dashboard/src/app-layout.tsx`; possibly a new `apps/dashboard/src/components/AppShell.tsx`; `apps/dashboard/src/test/app.test.tsx` (+ any nav/user-menu tests).
**Approach:** left sidebar ~240px at `lg+`: brand (teal logo tile + "canvas-drop" wordmark) at top, the primary nav as a vertical `SegmentedControl`-like list (active item = `bg-accent-subtle text-accent`, matching the preview), the account/user menu pinned at the bottom. Relocate the top-bar's right-side controls (Create canvas, Docs, theme switch) — Create canvas as a prominent rail button near the top; theme + Docs into the rail footer or a slim header strip. Keep the existing routes/links + the ⌘K palette + Admin gating intact. The content area keeps `--content-max` and the canvases route's own right rail (so on `xl` it's: left rail · library · right detail rail = the full three-panel).
**Test scenarios:** nav links render + navigate (Canvases/Gallery/Admin[admin-only]); active route marked (aria-current/pressed); Create canvas present; user menu present; existing app tests pass (update queries for the relocated controls).
**Verification:** Chrome screenshot at lg+ shows the left rail; matches the preview shape.

### U2. Responsive collapse for the shell
**Goal:** The left rail collapses gracefully on narrow screens.
**Files:** `apps/dashboard/src/app-layout.tsx` (+ reuse the mobile-menu focus-trap from P6 U10).
**Approach:** `lg+` fixed rail; below `lg` the rail collapses to a top bar with a hamburger that opens the nav (reuse the existing focus-trapped mobile menu). Keep Create canvas + palette reachable. No layout breakage at any width.
**Test scenarios:** below lg, hamburger opens the nav (focus-trapped, Escape closes); lg+ shows the fixed rail; nav reachable at all widths.
**Verification:** screenshots at lg + mobile.

### U3. Colourful / expressive touches (the "colour elements")
**Goal:** A few tasteful colour moments from the preview, without breaking "quiet chrome."
**Files:** `apps/dashboard/src/components/Brand.tsx` usage in the rail (teal tile); `apps/dashboard/src/components/GenerativeCover.tsx`; possibly the stat strip in `routes/index.tsx`.
**Approach:**
- **Teal logo tile** in the rail (rounded square, accent fill, white mark) — already the app-tile treatment from the logo sheet.
- **On-brand generative covers (finding X.1):** anchor `GenerativeCover` hues to the brand accent (teal) ±offset instead of the full hue wheel, so the gallery reads colourful *and* cohesive (with an escape-hatch for full-spectrum if trivial). Keep per-canvas distinctiveness via the existing hash seed.
- **Accent-subtle selected/active states** consistent across nav + selected card ring + filter chips (some already done).
- Optional: a subtle colour accent on the stat-strip labels or section eyebrows — keep restrained.
**Test scenarios:** GenerativeCover derives hue from the accent token (assert the produced hue is within the accent ±offset band); covers still vary by seed; logo tile renders teal with white mark.
**Verification:** screenshot the gallery + dashboard — colourful but on-brand.

---

## Risks
- **U1 is app-wide** (every route renders inside the shell). Keep it additive to routing; don't break the canvases route's right rail (the two rails must coexist at xl: left nav + right detail). Screenshot-verify.
- Keep the ⌘K palette, Admin gating, theme switch, and Create canvas all reachable after the relocation.
- Don't over-colour — "quiet chrome, expressive content" still holds; colour goes on the logo tile, covers, and selected states, not the whole chrome.

## Definition of done
All units committed to the branch; gates green each; then a **mega `/ce-code-review`** over the whole branch with all real findings fixed. Await Mark's yes for merge/push.

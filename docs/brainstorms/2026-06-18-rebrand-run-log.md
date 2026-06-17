# Editorial Creator OS rebrand — autonomous run log

Overnight autonomous run on `feat/rebrand-readiness`. Local commits only, no push, no PR.
Executing `docs/plans/2026-06-17-003-feat-editorial-creator-os-rebrand-plan.md`.
Every judgment call is logged here for morning review. Newest entries appended at the bottom.

## Conventions
- One commit per unit; gate (`pnpm typecheck && pnpm lint && pnpm test`, both dialects) green before moving on.
- Screenshots captured per phase into `design/run-screens/`.
- **DECISION** entries = judgment calls I made without you. **BLOCKER** = something I researched/worked around.

---

## Timeline

### Setup
- Branch `feat/rebrand-readiness`, worktree `../canvas-drop-rebrand`. Artifacts already committed (`60f87a0`).
- Starting P1 — Brand & token foundation.

### P1 — Brand & token foundation  ✅ (gates: typecheck + lint + test[both dialects] + build all green)
- **U1 brand layer:** `packages/shared/src/brand/{tokens,brand,logo}.ts` + exports. `BRAND_TOKENS` is the canonical OKLCH ramp; `rampCssVars()` emits it as CSS.
- **U2 parity test:** `tokens.test.ts` (53 checks) asserts dashboard `tokens.css` matches `BRAND_TOKENS` (light+dark) and that no indigo-violet (hue ~274) remains.
- **U4 scales:** registered `--text-*`, `--shadow-*` utilities, `--control-*`, `--content-max` in tokens.css.
- **U7 fonts:** Newsreader self-hosted (`@fontsource-variable/newsreader`); pre-paint theme bootstrap in `index.html` (FOUC fix).
- **Server surfaces:** error-pages + legal-pages now derive their ramp from `rampCssVars()` (single source). password-gate inherits it. landing/guest/social flipped off violet/blue.
- **Logo:** baked in Mark's working mark (drop-frame + arrow + `</>`) everywhere: shared `logo.ts`, dashboard `Brand.tsx`, server `brand.ts`, favicon.svg, brand/canvasdrop-mark.svg, regenerated PNGs (teal + warm paper), manifest.

**DECISIONS (judgment calls):**
- Collapsed plan's U3 (consolidate-preserving-values) + U5 (flip) into one direct flip to Editorial Creator OS values. No prod traffic to protect; the parity test + visual review are the safety net. Saved a redundant zero-change migration commit.
- Server system pages route through `rampCssVars()` → true single source, so no separate parity test needed for them (they can't drift). Landing/guest/social flipped by hand (violet→teal); landing gets a full consolidation in P7.
- Logo `</>` is drawn paths (not font) per Mark's working SVG. Inlined in `Brand.tsx` for dashboard bundle-safety (dashboard intentionally doesn't bundle `@canvas-drop/shared`); server uses the shared `logo.ts`. Geometry duplicated in 2 places (acceptable; logo is provisional).
- Manifest name "Canvasdrop" → "canvas-drop"; theme-color → teal #0c7b88; bg → warm paper.
- biome: ignore `design/` (preview/exploration artifacts, not shipped).

**BLOCKER resolved:** `@fontsource-variable/newsreader` has no `italic.css` export → used `standard-italic.css`.

### P2 — Typography (Newsreader serif)  ✅ (typecheck + lint + test green)
- base.css: `h1–h4` now Newsreader serif, weight 500, tighter tracking (the content voice). Controls/labels/meta stay sans.
- `PageHeader` h1 → `font-serif text-h1` (1.9rem editorial scale).
- Card titles (CanvasList + gallery) → serif (editorial-throughout). Verified live: "Your canvases" / "Ship your first canvas" render in Newsreader, light + dark.

**DECISION (from Mark, mid-run):** Skip regenerating the marketing site's preview/tour/og IMAGES in P7 — do the code/colour/serif changes only, leave the committed screenshots as-is. Updated the P7 scope accordingly.

### P3 — a11y baseline (slice 1)  ✅ (gates green)
- `--subtle` AA fix was already baked into P1's BRAND_TOKENS (light 0.500, dark 0.620).
- Scope toggle (index.tsx): dropped bogus `role=tablist/tab` + `aria-selected` (no keyboard tab model) → `role=group` + `aria-pressed` (it's a filter, not tabs). Finding 6.3.
- PublishBar ModeButton + PaneButton: added `aria-pressed` so the active state isn't colour-only — incl. the mobile pane switcher. Finding 6.2.
- Updated your-canvases-filters test (queried the toggle by the old `tab` role → `button`).

**DEFERRED within P3 (note for morning):** the primitive *consolidation* refactor (SegmentedControl/TabNav/SearchInput/DataTable/Tag/CodeBox + shared Variant/Size vocab) is a large maintainability refactor across many call sites. Prioritised the user-facing a11y wins + the visible reskin first. Remaining P3 consolidation + reduced-motion spinner label + mobile-menu focus-trap to follow.

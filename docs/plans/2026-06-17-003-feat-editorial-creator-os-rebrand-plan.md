# Plan — Editorial Creator OS rebrand

**Status:** ready to execute · **Branch:** `feat/rebrand-readiness` (worktree `../canvas-drop-rebrand`)
**Source of truth:** [`DESIGN.md`](../../DESIGN.md) (rewritten target), `design/BRAND-CUES.md`,
findings: [`docs/brainstorms/2026-06-17-rebrand-readiness-findings.md`](../brainstorms/2026-06-17-rebrand-readiness-findings.md).

This turns the rebrand-readiness findings (7 workstreams, 71 verified findings) plus the
agreed **Editorial Creator OS** direction into a runnable, dependency-ordered plan.

## Locked decisions

- **Direction:** Editorial Creator OS — editorial serif, warm minimalism, three-panel app, gallery-first, quiet chrome.
- **Serif:** **Newsreader** (content voice) + Geist (sans) + Geist Mono (identifiers).
- **Theme:** **light is default** (warm paper); deep navy is the system/`data-theme` alternate.
- **Accent:** **deep teal `#0c7b88`** as the single app accent; **amber `#e0a23a` marketing-only**. Indigo-violet is removed.
- **Color split:** app = Restrained (teal only); marketing/signed-out = Committed (drenched teal + amber).
- **Logo:** drop-frame mark (arrow + `</>`), drawn SVG — `design/brand/canvas-drop-mark.svg`. (Treat as provisional; may be replaced — keep it behind the brand layer so a swap is one file.)

## Method (the loop)

Plan-driven autonomous round: one branch, one local commit per unit, each unit's gates
green (`pnpm typecheck && pnpm lint && pnpm test` — both dialects) before the next.
Feature-bearing units carry tests. Run `/ce-code-review` before the PR; fix everything
real (P0/P1 + high-value P2) with regression tests; weight findings to the trusted-org
trust model. CI matrix green authorizes the merge. Capture learnings in `docs/solutions/`.

## Dependency order

P1 (brand+token foundation) unblocks everything visual → P2 (type) and P3 (primitives)
parallelize on top of P1 → P4 (app shell) needs P3 → P5 (copy), P6 (polish/motion) ride
on P3/P4 → P7 (marketing) needs P1+P2 → P8 (flow/efficiency) is the fast-follow round.

---

## P1 — Brand & token foundation  *(rebrand-readiness spine; rolls up findings W1+W2)*

The headline: give identity a single owner, prove a reskin is one edit, then apply the
new direction's values. Do it in two steps so the redirection is a provable single diff.

- **U1 — Extract the brand layer.** Create `packages/shared/src/brand/`: `brand.ts`
  (`BRAND`: name, wordmark, accentHue, logo colors, themeColor, fonts, githubUrl),
  `tokens.ts` (`BRAND_TOKENS`: the canonical OKLCH ramp, light+dark; accent/hover/subtle/
  ring derived from one hue), `logo.ts` (the SVG path-data, one source). *Tests:* unit
  test that `BRAND_TOKENS` exposes every required role for both themes; snapshot the
  derived accent steps.
- **U2 — Parity test first (the guard).** A test (model on the dual-dialect schema-parity
  test) asserting every surface's token map equals `BRAND_TOKENS`; fails CI on drift.
  Land it while values still match today's, so it guards the migration.
- **U3 — Point every surface at `BRAND_TOKENS`, preserving current values.** `tokens.css`
  (build-time inject / generated CSS string), `landing-page.ts`, `error-pages.ts`,
  `legal-pages.ts`, `docs/render.ts`, `guest-routes.ts`, `social-preview.ts`,
  `social-meta.ts`, `index.html` + `site.webmanifest`, `generate-brand-icons.mjs`. Unify
  the dark ramp (declare once, shared by `[data-theme="dark"]` + `prefers-color-scheme`).
  *Net: zero visual change, single source, parity test green — the reskinnability proof.*
- **U4 — Register the missing scales as utilities** (`@theme inline`): `--text-*` (serif +
  sans steps), `--shadow-*`, `--control-sm/md/lg`, `--content-max`. Bulk-replace the ~28
  font-size literals, 27 shadow passthroughs + 3 raw shadows, h-8/9/10 drift, the
  inlined content width. *Tests:* a lint/grep guard that fails on raw hex/px/arbitrary
  Tailwind color+shadow values in `apps/dashboard/src`.
- **U5 — Flip the source to Editorial Creator OS values.** Edit `BRAND` + `BRAND_TOKENS`
  only: warm-paper light (default) + deep-navy dark, **teal accent**, softer warm shadow
  geometry, bigger radii, `BRAND.fontSerif = Newsreader`. Regenerate icons; fix the name
  hardcoding (→ `BRAND.name`) + the manifest "Canvasdrop" spelling; install the logo from
  `logo.ts`; rewrite the pinned-blue test to assert the shared constant. **Re-verify AA**
  on every pairing in the new ramp (including `--subtle`). *This is the rebrand, as one
  diff to the brand layer.*
- **U6 — `REBRAND.md`.** Enumerate every seam: `BRAND`, `BRAND_TOKENS`, the logo source,
  `public/` masters + generator, `SITE`/`OPERATOR`, og image, identity-string list
  (cookies/storage/SDK global — "change only for a hard fork").

**Gate:** parity test + AA checks green; `pnpm typecheck && lint && test` (both dialects).

## P2 — Typography  *(serif system)*

- **U7 — Self-host Newsreader + register the type scale.** Add Newsreader (variable,
  italic) to the self-hosted font set; wire `--font-serif`; bootstrap `data-theme` in
  `index.html` to kill the FOUC. *Tests:* fonts resolve from the bundle (no external CDN);
  theme bootstrap sets `data-theme` pre-paint.
- **U8 — Apply the serif system.** Serif on page titles, section headings, card titles,
  detail-rail titles, and lead prose; sans stays on controls/meta/data; mono on
  identifiers. Italic-accent emphasis helper. *Tests:* heading components render
  `font-serif`; a visual smoke (screenshot) of the key screens.

**Gate:** as above. Can parallelize with P3 once P1 lands.

## P3 — Primitive consolidation + a11y baseline  *(W3 + W6)*

- **U9 — Shared vocabulary.** One `Variant`/`Tone` + `Size` module; standardize on
  `variant`; one `inputControl` string consumed by `Field`/`SlugField`/`PasswordField`.
- **U10 — New primitives:** `SegmentedControl`, `TabNav`, `SearchInput`, `DataTable`,
  `TextButton`, `Tag`, `CodeBox` — ARIA baked in (`aria-pressed`, `aria-current`/
  `activeProps`, focus management). Migrate the 4–5 segmented controls, 2 tab navs, 5
  search inputs, 2 admin tables, 3 "Clear filters" buttons, tag chips, code boxes.
- **U11 — A11y baseline:** darken `--subtle` to clear AA (in the new ramp); fix the
  mobile pane-switcher ARIA; drop bogus tab roles on the scope toggle; mobile-menu
  focus-trap + Escape; reduced-motion feedback (Saving… label; HoldButton). *Tests:* a11y
  assertions on the new primitives (roles, `aria-pressed`, focus); contrast unit checks.

**Gate:** as above; primitive unit tests required.

## P4 — Three-panel Creator workspace  *(the layout direction; reframes W7.2)*

- **U12 — `AppShell`** (left rail / center library / right rail) with the responsive
  collapse (drawer < 1280, bottom sheet < 768; reuse `Dialog` trap + mobile menu).
- **U13 — `DetailPanel`** (right rail): selected canvas → cover/status/actions/details/
  activity. Selection ≠ navigation; keyboard selection (arrow/Enter); the full detail
  route keeps the deep surfaces (Overview tab folds into the rail). *Tests:* selecting a
  card populates the rail without navigating; keyboard selection; rail actions wire to
  the same service calls.
- **U14 — `CanvasCard`** gallery-first hero card + one hover model (codify in
  `row-styles.ts`); on-brand `GenerativeCover` (hues from the accent ±offset). *Tests:*
  cover hue derives from the brand token; card states.

**Gate:** as above; layout + interaction tests.

## P5 — Copy centralization  *(W4)*

- **U15 — `copy/*.ts` modules** (toasts, confirms, empty-states, buttons) + `PRIMITIVES`
  map + `versionLabel(n)` + `count(n, noun)`; fold in `HINTS`/`RUNGS`/`Badge` maps; wire
  `BRAND.name`. Fix: Backend/Capabilities contradiction, clone/duplicate naming, version
  label format, generic "Something went wrong" → "Couldn't X. Try again.", Retry→Try again.
  *Tests:* copy resolves from the module; no inline generic-error literals (grep guard).

**Gate:** as above. Partly parallel with P3 once the module shape lands.

## P6 — Polish & motion  *(W5 + remaining W6)*

- **U16 — Motion set:** keyframes for overlay fade+scale, menu, toast slide-up; reuse
  `--ease-out` + reduced-motion. Dialog scrim/entrance; two-phase toast removal.
- **U17 — Coherence:** focus-ring follows control radius (drop the global radius:2px);
  one focus idiom; Dialog optional close (X); touch-target sizes on coarse pointers.
  *Tests:* reduced-motion path; focus-visible present; exit animation via data-state.

**Gate:** as above.

## P7 — Marketing bold pass  *(Committed treatment; teal + amber)*

- **U18 — Landing + signed-out surfaces** to the Committed direction: Newsreader hero
  with the italic-accent move, drenched teal hero/CTA bands, amber second accent,
  per-primitive tints, on-brand covers. Apply to `landing-page.ts` (+ error/legal/guest
  visual block) via `BRAND_TOKENS` + the amber marketing token. *Tests:* server-rendered
  HTML uses shared tokens (no inline hex); AA on the drenched surfaces.

**Gate:** as above.

## P8 — Flow & efficiency  *(W7 — fast-follow round, can ship separately)*

- **U19 — Command palette** (⌘K: navigate/create/jump/deploy) + ⌘↵ publish; discoverable
  affordance. **U20 —** tab overflow handling (now mostly absorbed by the rail) + the
  shortcut cheatsheet. **U21 —** slug-aware detail lookup (paste-slug → canonical UUID).
  **U22 —** JS-canvas in-editor preview. *Tests per unit.*

---

## Risks & guards

- **Dual-dialect** stays sacred — schema work (none expected here) keeps both dialects green.
- **AA regressions** from the new warm/navy ramp — U5/U11 must re-verify every pairing.
- **Parity test** must land in U2 *before* the migration, or drift sneaks back in.
- **Scope creep:** P1+P2+P5-centralization are the rebrand-readiness gate (must land);
  P4/P6 are the quality payload; P8 is explicitly a fast-follow — don't let motion/flow
  block the brand-layer extraction.
- **Logo is provisional** — keep it behind `BRAND`/`logo.ts` so replacing it stays one file.

## Definition of done (per the autonomous round)

All units in scope built, each gate green; `/ce-code-review` run and real findings fixed
with regression tests; full dual-dialect suite + CI matrix green; issue closed; learnings
captured in `docs/solutions/`; `main` left green. A second brand can be dropped in by
editing only the brand layer (the parity test enforces it).

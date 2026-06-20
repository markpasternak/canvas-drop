# Design skins — the expression layer (and how to extend it)

**Context:** themable design *language* an admin can flip instance-wide (`editorial`
default + `studio`/`workshop`/`canvas`). Plan: `docs/plans/2026-06-20-001-feat-themable-design-skins-plan.md`.
PR #54.

## The shape

A third token layer between **System** (geometry) and **Brand** (one ramp): a skin is a
*partial* override of brand tokens — accent family + display bundle (`--font-display` /
`--display-weight` / `--display-tracking`) + `--radius-scale` — emitted as `[data-skin]`
blocks. **Token-only: no layout forks.** Canonical source is
`packages/shared/src/brand/skins.ts`; the hand-authored `tokens.css` blocks are kept in
lockstep by the parity test, and a WCAG-AA test guards every skin's contrast.

## Gotchas worth keeping (each cost real time)

- **An `editable: true` config field is dead until a consumer reads its *override*.** The
  first cut wired `core.designSkin` and saved the DB override, but `/api/me`/landing still
  read the boot `config.designSkin` — so the admin flip did nothing until restart. The
  pattern is `adminSettingsService.effective<X>()` (`DB override ?? env/default`), resolved
  **per-request**. Mirror `effectiveRealtimeEnabled`/`effectiveScreenshotsEnabled`. If you
  make something editable, route every consumer through the effective getter.
- **The dashboard must not import `@canvas-drop/shared`** (it would pull zod + the server
  schema into the browser bundle — see the `AuthMode` comment in `apps/dashboard/src/lib/api.ts`).
  Restate small unions browser-side (`DesignSkin`) and keep them in lockstep by comment.
- **`tokens.css` is hand-authored, not generated** (Tailwind consumes it directly). Every
  skin value lives in BOTH `skins.ts` and `tokens.css`; the parity test is what stops drift —
  extend it whenever you add a per-skin token. Server surfaces use `skinOverridesCss()` from
  the same source instead of hand-CSS.
- **OKLCH is perceptually even but not contrast-safe.** The AA test (`contrast.ts`) caught
  studio + workshop badge text at ~4.0–4.1:1 on first authoring. Author skins, then let the
  test tell you what to darken/lighten.
- **Radius scaling rides `calc()` inside `@theme inline`:** `--radius-md: calc(0.75rem * var(--radius-scale, 1))`. The literal is inlined into the utility but the inner var stays
  runtime-overridable — scale defaults to identity, so editorial is unchanged.
- **`font-display` sets family + weight only, NOT letter-spacing.** A uniform
  `--display-tracking` regressed the editorial default (headings were −0.01/−0.018/0em).
  Tracking stays per-surface; page titles opt into `--display-tracking` explicitly.
- **Structural chrome is CSS-gated, not forked.** The IDE status bar + window-dots are
  always in the DOM behind `.cd-statusbar` / `.cd-window-dots` (hidden by default); a
  `:root[data-skin=…] .x` descendant rule reveals them per skin. No JS skin branching, and
  editorial/studio stay untouched.

## Where to take it next (deliberately deferred)

1. **Per-skin elevation depth.** Skins flip accent/display/radius but shadows + border
   weight still come from the System layer, so they read less distinct than the prototype
   (canvas wanted hard offset shadows; workshop flatter). Doable token-only by overriding
   the `--shadow-*` scale per skin — but it's the load-bearing elevation system, so it wants
   care + parity/AA coverage. Highest "feel" ROI remaining.
2. **Generalize the `--chrome` gate.** The structural-chrome reveal is currently two bespoke
   classes; a single `[data-skin]`-driven `--chrome` switch with a small documented set of
   opt-in flourishes would scale it cleanly.
3. **Data-authored skins = the rebrand unification.** The end-state: the default brand *is*
   just a skin, skins are authored as data (a JSON registry, not TS edits), and an org's
   whole rebrand becomes "author a skin" with the parity + AA tests guaranteeing correctness.
   This collapses "skins" and "rebrand" (`REBRAND.md` vision) into one mechanism.

Not done (scope calls): per-skin browser `theme-color` (low value); error/legal pages stay
editorial (system surfaces; skinning them re-introduces the boot-vs-effective seam).

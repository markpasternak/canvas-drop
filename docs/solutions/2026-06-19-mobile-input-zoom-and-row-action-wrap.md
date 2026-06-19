# Mobile web: iOS input zoom + crushed list-row actions

Two recurring mobile-Safari (iPhone) gotchas in the dashboard, fixed together.

## 1. iOS auto-zoom on focus (every form control)

**Symptom.** Tapping any field on a phone makes Safari zoom + pan the page. The
share-page "Share expiry" `datetime-local` looked especially wrong: iOS sizes the
native date/time control from its font, so at 14px it renders oddly tall and empty.

**Cause.** iOS Safari auto-zooms whenever a focused `input`/`select`/`textarea` has a
computed `font-size` below **16px**. Our shared control recipe (`inputControl` in
`apps/dashboard/src/lib/input-styles.ts`) is `text-sm` (14px) for a denser desktop UI,
so *every* field triggered it — text, search, the allowlist email, admin settings, and
the date/time pickers.

**Fix.** One base rule (`apps/dashboard/src/styles/base.css`), not per-component:
```css
@media (max-width: 639px) {
  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]),
  select, textarea { font-size: 16px; }
}
```
Below the `sm` breakpoint the control font is pinned to 16px → no zoom, and the native
date/time controls size consistently with text inputs. Desktop keeps the denser 14px.
Checkbox/radio/range/color are excluded so their box sizing is untouched. This is the
canonical fix — don't bump `text-sm` per-field.

## 2. List-row actions crushing the title

**Symptom.** On the canvases list (and gallery list mode) the title truncated to a few
characters ("Th…", "Se…"). The trailing Details/Open/⋮ cluster sat inline next to the
title and ate the horizontal room.

**Cause.** `CanvasListRow` laid out `[cover] [text flex-1] [stats] [actions]` in a single
non-wrapping `flex items-center` at every width. On a ~375px phone the fixed-width action
buttons left almost nothing for the `min-w-0` title column.

**Fix.** The row already presents as a card below `lg` (`lg:rounded-none lg:border-0`).
Make that breakpoint reflow the actions onto their own line:
- wrap the container in `flex-wrap` with a `gap-y`,
- group cover+text into one block that is `basis-full` (full row) below `lg` and
  `lg:basis-0 grow` (shares the row) at `lg`,
- give the actions `max-lg:ml-auto` so they right-align on their wrapped line.

At `lg+` the desktop list is unchanged (one line, actions trailing). The `actions` slot is
rendered **once** — it carries portal dialogs (Clone/Confirm), so duplicating it for a
"mobile copy" would double that state. Reflow with flex, don't re-render.

## Takeaways
- Any new input must clear the 16px floor on mobile — the base rule handles it globally,
  so don't reintroduce a `text-[14px]` control without remembering the zoom tradeoff.
- For "actions vs. text" rows, reflow the single actions node with flex-wrap/`basis-full`
  at the card breakpoint rather than conditionally rendering a second copy.

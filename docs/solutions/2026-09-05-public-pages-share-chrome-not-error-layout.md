---
title: Public pages share branding without inheriting error-page layout
area: public-pages
type: design
date: 2026-09-05
---

# Public pages share branding without inheriting error-page layout

Docs, Privacy and Terms already consumed the canonical SVG paths, but looked disconnected from the dashboard and marketing page. The docs header inherited a large bottom margin from the centered error-page brand wrapper; legal pages forced dark mode and had no primary navigation. Geometry parity alone did not establish visual consistency.

`apps/server/src/http/site-chrome.ts` now owns the public reading surfaces' fonts, token/theme rules, logo tile, header, footer and theme switch. Marketing, docs and legal pages consume that shell. Error and password pages retain their focused system layout. Legal text, operator details and policy dates are unchanged.

Keep these boundaries when updating the public pages:

- Use the canonical `BRAND_MARK`, `rampCssVars` and skin overrides. The public logo tile uses the same accent/foreground treatment and dimensions as the dashboard.
- Use the existing `canvas-drop-theme` preference. A legal page must not silently override a visitor's saved appearance.
- Keep docs navigation available without JavaScript. The native disclosure begins open; the small client collapses it on mobile and expands it on desktop. Escape closes an open mobile menu and returns focus to its summary.
- Search results must remain mounted while keyboard focus moves into their links. Dismissal must also invalidate pending search work, or a late response can reopen results after blur or Escape.
- Safari may blur the search input without focusing a clicked result. A null `relatedTarget` does not prove the visitor left the search region: preserve the result until activation, dismiss on outside pointer interactions, and keep normal keyboard focus-out dismissal. Do not prevent pointer defaults on the results, which would interfere with scrolling.
- Reveal and delegate theme controls in the head script. Waiting for `DOMContentLoaded` also waits for deferred bundles such as Mermaid, causing a late header reflow and delaying the switch. Synchronize pressed states when the parsed DOM becomes interactive without resetting a choice made during parsing.
- Keep tables as native tables inside a separate horizontal scroll region. Inheriting `overflow-wrap: anywhere` from the article collapses the min-content width of short columns to a single letter; reset wrapping within tables, preserve a readable minimum column width, and let the wrapper scroll on narrow screens.
- Cache-bust the theme, navigation and search clients with their content hash. Their routes remain public and same-origin under the existing docs CSP.

Verification: owner-reviewed local preview; shared-shell/skin and route assertions; DOM tests for navigation resizing, Escape/focus, keyboard and pointer search, delayed-response dismissal and persisted theme. The delayed blur/Escape, Safari pointer activation and pre-DOM-ready theme cases failed before their fixes and passed afterward. Full dual-dialect/dashboard checks and CI remain the release gate.

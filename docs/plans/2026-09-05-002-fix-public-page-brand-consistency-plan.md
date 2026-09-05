---
title: Consistent public-page branding and navigation
type: fix
status: active
date: 2026-09-05
---

# Consistent public-page branding and navigation

Follow-up to the approved UX release: the docs, Privacy and Terms pages must feel like the same product as the landing page and dashboard. The logo geometry is already shared, but the presentation and navigation have drifted.

- [x] Share the public header, logo tile, footer, fonts and theme controls between marketing, docs, Privacy and Terms. Respect the active instance skin and saved theme; retain public access and existing login behavior.
- [x] Remove the docs shell's dependency on error-page layout. Give its sidebar clear current-page states, useful spacing, and a keyboard-operable mobile disclosure with a usable no-JavaScript fallback. Keep search and previous/next navigation working. Preserve readable table columns inside keyboard-scrollable regions.
- [x] Give legal documents the same page chrome and a clear Privacy/Terms switch. Preserve the legal text, operator facts and policy dates.
- [x] Verify desktop/mobile, light/dark, active skins, keyboard navigation, theme persistence and public routes. Add regression tests for navigation behavior and cross-surface brand consistency; run lint, typecheck, full dual-dialect/dashboard tests and build.
- [ ] Review, merge through green CI, deploy the follow-up, and verify the live pages.

No new authorization, backend capability or persistence model is introduced. Gallery and the eleven-view marketing walkthrough remain as released.

Implementation evidence: Mark reviewed the local preview and approved its appearance. Shared brand/skin and route checks pass; DOM regression tests cover mobile/desktop navigation state, Escape and focus, keyboard and pointer search results, delayed-response dismissal and saved theme. Final lint, typecheck, full dual-dialect/dashboard tests (2,983 server/tooling and 738 dashboard tests) and build pass. HTTP checks cover 30 public pages, 119 tables and every referenced client script. Browser dimensions were not independently rechecked while Safari was in active use; the local appearance check is the owner's approval.

Table follow-up: the owner found letter-by-letter wrapping on the Agent skill page. The article-wide wrapping rule and block-level table were replaced with native table layout, normal word wrapping, minimum column widths, top-aligned cells, and a separate keyboard-scrollable region. The table wrapper regression passes against that page.

Review: sequential local review per repository tool mapping and an independent Claude CLI review completed. Three reproducible findings were fixed: delayed search reopening, Safari pointer activation, and theme controls waiting for deferred bundles. Their regressions failed before and pass after the fixes. Local finding validation was inline, not an independent second reviewer. Track merge, CI and production verification on issue #110.

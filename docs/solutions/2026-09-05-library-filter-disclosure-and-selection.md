---
title: Keep narrowed libraries recoverable when filters are collapsed
type: design
area: dashboard
date: 2026-09-05
---

# Keep narrowed libraries recoverable when filters are collapsed

Moving advanced filters behind a disclosure makes the canvas names easier to scan, but the disclosure must not hide the explanation or the way back. Keep the active-filter count on its toggle and a search/filter reset beside the result count. A search-only view needs that reset too. Count filters with the same truthiness used by the query, including hand-edited URL values.

Filter state stays in the URL; whether the controls are expanded is a local presentation preference. Open the controls when the view first becomes filtered, and preserve a deliberate collapse while showing its count. Bulk selection must reset on every membership-changing filter, including owned versus edited.

Tests that assert a control is absent must open the disclosure first. A role query excludes hidden subtrees, so otherwise a broken control can pass an absence assertion. Navigation tests should target the actual name link or row body rather than incidental metadata such as a slug that may disappear during visual simplification.

Shared covers use the same canvas-update cache key as owner covers. This refreshes covers after ordinary canvas updates; it does not claim that a background screenshot recapture alone changes the cache key.

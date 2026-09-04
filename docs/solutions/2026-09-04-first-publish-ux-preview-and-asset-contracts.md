---
title: First-publish UX — preview isolation, uncertain sharing, and asset drift
type: implementation
area: dashboard
date: 2026-09-04
---

The [approved round](../plans/2026-09-04-001-feat-publishing-experience-plan.md)
changes marketing, Create, the canvas workspace, and the SVG identity. It adds no
management operation, schema, permission model, or MCP capability.

## Preserve what demonstrates the product

Keep the original 11-view walkthrough, including Gallery. Marketing visitors cannot
open the authenticated Gallery, so the landing page uses committed example images
with manual navigation, an example-content label, and no gated Gallery link. The
problem is taking artifacts out of their original chat, cloud workspace, or laptop
and making them useful to a team with controlled access.

Scope `touch-action: pan-y` to the enhanced carousel. Applying it to the native
horizontal-scroll fallback prevents horizontal touch navigation when JavaScript is
unavailable. Reduced motion uses zero-duration manual transitions.

## An HTML layout preview must not execute or fetch

Create parses pasted HTML in an inert template, removes active and navigable markup
(including `noscript`, which parses differently with scripting disabled), and renders
it in an empty sandbox. A CSP precedes supplied content and denies external fetches;
only inline styles and embedded raster images remain. Never add `allow-same-origin`
or `allow-scripts` to this layout preview. Large documents can still publish even
when the bounded inline preview is omitted.

The browser network probe produced no requests for test script, image, meta-refresh,
or CSS import URLs. The existing editor's explicit scripted-preview opt-in and
opaque sandbox remain unchanged.

## Preserve upload intent and honest results

Selecting files stages them; only Create and publish writes. Detect a deploy ZIP only
when it is one top-level file. A ZIP inside a selected folder is a static downloadable
asset, including a folder containing only that ZIP. Use `rawUploadPath` before the
common-wrapper stripping in `canvasRelativePaths`; otherwise these cases are
indistinguishable. Regression tests cover both directory-picker and dragged paths.

A failed sharing response does not prove the server rejected the update. The result
says sharing could not be confirmed and sends the user to Share before distribution.
It preserves the published canvas and once-only key. Save and explicit skip choices
clear the key from React state immediately; auxiliary links open separately to
preserve staged work and the result screen.

## Covers and brand assets have separate freshness contracts

Overview uses the same `updatedAt` cover URL cache-buster as list/detail/settings
views. An image remount alone cannot bypass the browser's five-minute HTTP cache.
Do not expose live links for archived or disabled canvases or claim unavailable
version details are an unpublished canvas. Draft lookup errors remain unknown state.

`pnpm brand:build` generates vectors, PNG icons, and social cards from the canonical
32-unit mark. Dashboard mirror tests compare path geometry and stroke widths. Sharp's
`extend` only paints added border pixels; `flatten` is also required for an opaque
app icon. The committed PNG alpha check prevents the transparent-center regression.
Static social artwork uses explicit serif/sans fallback families because the image
renderer cannot reliably load WOFF2; web surfaces continue self-hosting the brand
fonts. Inspect generated artwork, not just the command's exit status.

## Review and release receipt

Local correctness, security, reliability, testing, maintainability, frontend race,
standards, and agent-parity passes ran sequentially under the repo tool mapping.
An independent Claude peer completed the adversarial review (run
`20260904-233950-102fd1f7`, reported model `claude-opus-5`). It corroborated three
actionable findings: cover caching, ZIP classification, and PNG transparency. All
three were fixed with focused regressions. The font fallback was corrected and
visually checked; the existing stroke-width parity test was strengthened. Speculative
large-document typing latency was not presented as a measured regression.

Local validation covers both database dialects, dashboard behavior, lint, types,
build, and desktop/mobile browser checks. CI remains the merge gate. No production
deployment is part of this round.

**Release prerequisite requested by Mark:** capture fresh marketing walkthrough and
documentation screenshots after the final UI is ready and before deployment. Replace
the old Create, Overview, editor, Gallery, and remaining walkthrough images using
seeded example content. The existing screenshots are not release-ready assets.

---
title: A clearer first publish — marketing, Create, and canvas workspace
execution: code
origin: docs/brainstorms/2026-09-04-canvas-drop-ux-direction.md
---

# A clearer first publish

## Goal and authorization

Mark approved the proposed first round with “lets go”: homepage + Create/success + Overview/editor hierarchy. Execute all three units on one feature branch and one PR, with unit commits, local gates, code review, CI, squash merge, and issue closure per AGENTS.md. Production deployment is outside this round.

Make the canvas itself prominent, reduce the decisions before content entry, and distinguish a saved draft from a published canvas. Preserve the existing static-first, tenant, access, one-time-key, and preview-isolation contracts.

## Scope and decisions

- Build on the existing stack, brand tokens, and instance-selected skins. Editorial remains the default; no instance setting is changed. Lead with the existing Gallery preview, as Mark requested during implementation. Label its seeded examples and pictured Editorial skin; the surrounding page follows the active skin. Keep documentation/tour assets available for existing consumers.
- The gallery preview uses committed, seeded sample imagery, with a keyboard-accessible link to the normally authenticated Gallery. No invented publish simulation, uploads, sign-in bypass, or server mutations. It remains readable without JavaScript and respects reduced motion.
- Paste HTML, upload files/folder/ZIP, and API creation remain supported. Legacy `?method=folder|zip|api|paste` links work. Files are selected for review, then explicitly published; selection alone no longer creates a canvas. HTML receives a non-executing, network-blocked document preview. Multi-file/ZIP uploads receive a file/archive summary rather than a misleading partial-site render. Full-site preview continues to use the existing authenticated draft flow after creation.
- Workspace and audience stay visible. Optional slug/backend settings are disclosed on demand. API creation retains its one-time-key result; ordinary publishing gets a link-led success surface with an explicit save-or-continue key choice. Partial sharing failure reports Restricted and links to recovery without redeploying or deleting the published canvas.
- Overview leads with a cover, publication/draft state, audience, and useful actions. Existing lifecycle-specific actions remain. Basics move into an expandable editing section, preserving autosave. Editor action names distinguish upload replacement, draft save, and publish. The existing scripted-preview opt-in and sandbox are preserved.
- No new backend primitives, DB/schema changes, new permission semantics, telemetry, library pins, broad search, gallery redesign, or quick-share panel. Those are separate proposals. No new durable management operation is introduced, so existing HTTP/MCP service parity is retained.

## U1 — Make the homepage demonstrate the product

Files: landing-page.ts, landing-design.ts, and tests; existing docs/site/assets; brand guidance where current text is stale.

Approach: short hero with a prominent gallery of existing sample canvases, succinct publish/share/version story, compact capability detail, and team/self-host guidance. Keep SEO, self-hosted fonts, all six primitives plus authoring, legal links, skin propagation, safe escaping, routing, CSP, and signed-in/auth-mode CTA behavior. Use token colors, type and consistent light/dark surfaces; remove the invented demo and keep the gallery as the main product visual.

Verification: rendered-content/routing/security/skin tests, gallery image and destination tests; browser keyboard/tap, desktop/mobile, light/dark, reduced-motion, and multiple skins. HTML and JS work without external services.

## U2 — Put content and the result first in Create

Files: routes/new.tsx; narrowly scoped create-preview/success components and helpers as needed; existing upload primitives only if required; new/new-canvas/deploy/create-audience tests; user docs.

Approach: source controls and content first, compact destination/audience controls, progressive optional settings, staged file selection plus explicit publish, safe HTML-only preview with editable title suggestion, template and agent setup entry links, and success surface showing link, accurate audience, one-time key guidance, and Open/Share/Continue actions. No key persistence or logging. Disable mutable creation controls while a request is in flight and prevent duplicate submissions.

Verification: paste, files/folder/ZIP dispatch and no writes before publish; relative paths; invalid selection; title edits; preview cannot execute scripts or fetch external assets; rapid source changes cannot commit stale previews; slug/audience gates; immutable workspace destination; restricted defaults; busy controls; upload cleanup; sharing failure preserves published result; key save/skip and API flow. Use existing server operations/MCP equivalents unchanged.

## U3 — Make the canvas workspace show state and next actions

Files: routes/canvas.overview.tsx, routes/canvas.tsx, components/PublishBar.tsx, components/DraftPreview.tsx, relevant tests, docs and design guidance.

Approach: substantial cover with link to live canvas when available, compact current-version and draft summary, Edit draft/Share/View live actions subject to lifecycle gates. Move existing Basics fields to progressive disclosure without changing autosave sequencing. Say Canvas URL for a restricted-capable link. On editor, keep Publish/Publish update primary and clearly label Upload new version separately. Tighten scripted-preview explanation; retain the opaque sandbox and explicit opt-in, full-preview route, focus and refresh behavior.

Verification: draft/published/expired/unpublished/archived/disabled states, missing home page, owner/editor gates, debounced metadata saves including trailing cleanup, absent/failed covers, long titles/mobile, publish busy/conflict states, same sandbox attributes and opt-in behavior. No false claim that a cover verifies runtime health.

## Verification and Definition of Done

## U4 — Refine the SVG identity

Mark added this scope during implementation: improve the logo using SVG. Refine the
existing canvas/drop idea with simpler geometry and legibility at small sizes; retain
the product name and the active skin's colors. Update the canonical geometry, dashboard
mirror, favicon/PWA and downloadable brand assets, and generated social artwork together.
Verify geometry parity, SVG validity, 16/24/32px appearance, light/dark and monochrome
use, and the mark beside the wordmark. Keep editable vector sources and reproducible
asset generation. No changes to instance settings or production deployment.

## Final gates

Before each unit, sync from main. Use focused tests to prove changed behavior and run pnpm lint, pnpm typecheck, and full pnpm test (SQLite + pglite + dashboard) before each unit commit. Run pnpm build for final UI validation, regenerate docs when their source changes, and follow generated-asset checks. Keep local preview artifacts and logs outside commits.

Run ce-code-review with the repo's sequential tool mapping, addressing correctness, security/preview isolation, reliability, type safety, accessibility/design, maintainability, tests, and agent parity. Fix real P0/P1 and high-value P2 findings and record a receipt. Capture non-obvious learnings in docs/solutions. Required GitHub CI checks must pass before squash merge; close the tracking issue and update current status pointers. No private production content appears in samples, tests, screenshots, or the PR.

Done when all three units are implemented, reviewed, validated, documented, merged through green CI, and the tracking issue is closed. Unit progress lives in commits and the issue, not this plan body.

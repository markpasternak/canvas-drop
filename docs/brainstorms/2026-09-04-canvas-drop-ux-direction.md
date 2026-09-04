---
title: Canvas Drop — targeted UX and visual direction
status: proposal
date: 2026-09-04
---

# Canvas Drop — targeted UX and visual direction

Make the product's central promise tangible: something a person built becomes a useful, accessible canvas their team can confidently use and improve.

This is a design proposal, not an approved implementation plan. The current product already has substantial functionality. Focus the next round on first impression, first publish, and repeat use.

## Evidence and limits

Reviewed current `main` at `8e7f715` after `git pull --ff-only`; the live marketing page, signed-in library, creation form, canvas overview, sharing, editor, and gallery; and the marketing page at phone width. The signed-in `/welcome` alias presents the same marketing content but changes the sign-in CTA to Open dashboard. Signed-out CTA behavior was checked in source.

The live instance uses the purple Canvas skin. The tour screenshots use the teal Editorial skin. The current browser showed a light dashboard and dark marketing page. The source confirms the landing follows OS appearance, while the dashboard supports a stored override. These are observed inconsistencies in the review state, not evidence that either theme is broken.

This was a heuristic review. No production content, permissions, settings, or deployments were changed. First-publish and failed-upload behavior was inspected in source, not executed against production. No usability sessions or performance measurements were performed. Proposed effects on activation and task speed are hypotheses to test.

## 1. Make the homepage demonstrate the promise

**Observed:** the hero is largely text and empty gradient space. A long paragraph precedes the product. An eleven-screen carousel follows, including admin and backend screens. Later sections repeatedly explain permissions, infrastructure, and capabilities. Full desktop screenshots lose their useful detail on a phone.

**Proposed:** keep the memorable “Drop it in. Share it out.” headline. Shorten the supporting copy to: “Turn the web tools you build into links your team can use. On your infrastructure, behind your sign-in.” Put an actual, legible example beside it.

Build one distinctive interaction: choose a prepared example, see its files become a canvas, then see its link and access summary. Label the experience a demo; keep it local and use prepared sample content. A real deployment continues through the normal authenticated flow. Ensure tap and keyboard alternatives to any drag gesture, and a reduced-motion equivalent.

Restructure the page around five beats: promise and demonstration; three useful examples; create → publish → share; team control; self-hosting. Use outcomes such as a project roadmap, a calculator, and an interactive report before explaining the six backend primitives. Keep the capability detail accessible lower on the page and in docs. The primary evaluation action should be “Try a sample”; self-hosters get a clear “Run it for your team” path, and existing members retain Sign in.

**Visual direction:** sharpen the existing Editorial direction: expressive Newsreader headings, Geist controls, warm paper, dark ink, deep teal, selective amber, generous framing around the canvas itself. Reduce repeated uppercase eyebrows, rounded containers inside containers, and competing badge fills. Use flat rows for structure and elevation for objects. Choose one flagship presentation for the public product site and keep its screenshots in the same skin. Preserve the existing skin system; changing how a marketing site selects its skin is a separate explicit product decision.

**Seams:** `apps/server/src/http/landing-page.ts`, `scripts/landing-carousel.src.mjs`, committed tour assets, `packages/shared/src/brand/skins.ts`, dashboard tokens. The interactive sketch reviewed in the conversation demonstrates composition and the local sample interaction; it is not a production implementation or a full brand specification.

## 2. Put the artifact first in Create

**Observed:** choosing Paste HTML still presents title, slug, workspace, audience, and backend settings before the HTML input. Uploading files and a ZIP are separate choices. Each non-API creation path culminates in the blocking `ApiKeyReveal` dialog.

**Proposed:** lead with a large drop/paste surface that accepts files, a folder, or a ZIP and routes to the existing handlers. Give paste a clear equivalent. Offer “Start from a template” and “Connect your agent” as additional entry paths. Once content is supplied, show a sandboxed preview, a suggested editable name, destination workspace, and visible audience summary before the publish action. Move optional URL and backend controls into progressive disclosure. Keep the destination explicit because workspace choice is immutable after creation.

The success state should show the canvas, its link, its current audience, and Open / Copy link / Share. Keep one-time API-key handling available with an explicit choice to save it or continue without it and clear regeneration guidance. Never imply an unretained key can be retrieved later. For API creation, the key remains the central result. Preserve partial-success recovery when publish succeeds but sharing fails.

**Test hypothesis:** newcomers can publish a prepared HTML sample and correctly describe who can open it in under a minute, without coaching. This is a proposed target, not a measured baseline.

**Seams:** `routes/new.tsx`, `components/DeployFiles.tsx`, `components/ApiKeyReveal.tsx`, `lib/create-audience.ts`, existing clone flow and MCP onboarding docs.

## 3. Make the library easier to scan and resume

**Observed:** the list view shows five summary statistics, two filter rows, multiple access labels, slugs, versions, file counts, storage size, views, created time, and actions. Much of this competes with the canvas name and preview.

**Proposed:** keep name, useful cover, audience, publication state, and last meaningful update prominent. Move storage, file counts, created date, and secondary identifiers to the existing detail rail. Consolidate infrequent filters behind a Filters control while keeping active filters visible. Keep the list/grid choice and the user's preference. Bring the existing command palette into view with a Search / ⌘K affordance.

For return use, consider a small pinned area and recently opened canvases across owned, edited, and shared access. Pinned state is new functionality and should be a later unit with persistence, role-safe filtering, and MCP parity. Do not infer availability from an old visit after access is revoked. Avoid an additional dashboard full of metrics.

Improve recognition: stable crops, title-aware fallback covers, and a visible cover action in the detail rail. The current account contained one nearly blank preview; a capture can succeed technically while producing a poor cover.

**Seams:** `routes/index.tsx`, `routes/shared.tsx`, `components/CanvasListRow.tsx`, `components/CanvasCover.tsx`, `components/DetailPanel.tsx`, `components/CommandPalette.tsx`.

## 4. Make the canvas overview show the canvas

**Observed:** overview starts with full-width metadata fields and repeats publication/access/URL facts. It offers seven similarly prominent tabs and a global New version button. The editor contains both New version and Publish. For a JavaScript canvas, preview begins with a large explanatory gate.

**Proposed:** use a substantial cover or safe preview, a compact live-versus-draft summary, the audience, and contextual actions as the overview. Move rarely changed metadata into compact inline editing or Settings. Use “Canvas URL” instead of “Public URL” for links that may be Restricted.

Give the editor more working space and clear task language: Edit draft; Saved to draft; Unpublished changes; Publish update; View live. Add a concise review of changed files before publishing where it helps. Put file replacement under “Upload new version” so it is distinguishable from publishing the editor draft. On the editor surface, one primary action should match the current task.

Preserve the preview isolation model. Offer “Quick preview” and “Open full preview” with concise, contextual limitations. Never imply a sandbox preview proves authenticated backend behavior, and do not remove the JavaScript gate merely to improve appearance.

**Seams:** `routes/canvas.overview.tsx`, `routes/canvas.tsx`, `routes/canvas.editor.tsx`, `components/PublishBar.tsx`, `components/DraftPreview.tsx`.

## 5. Make sharing readable at the point of use

**Observed:** the current sharing view already correctly separates direct access, general access, and protection. It remains a long management page with repeated policy prose. Copying the URL does not by itself make the recipient's access obvious.

**Proposed:** keep the permission model and add a concise summary near Copy link, such as “Restricted · You and the people and teams listed below.” A compact quick-share surface can expose Copy link, Add person/team, and the current audience, with the full page retained for detailed management. Reuse the same controls and services.

Explain capability consequences where they matter: “People opening a public link get a static view.” Keep publication status, audience, password/expiry, and discovery as distinct concepts. Show pending versus effective access accurately. An editor can manage sharing, so copy must not imply owner-only control where the code permits editors.

**Seams:** `routes/canvas.share.tsx`, `components/PeopleAccessList.tsx`, `components/DetailPanel.tsx`, the shared management services and role resolver. Any new capability requires HTTP/MCP parity and authorization tests.

## 6. Turn Gallery into a useful starting point

**Observed:** the reviewed account's gallery showed one template under a full search/filter/pagination apparatus. Templates, cloning, and featured content already exist. This observation says nothing about wider adoption or other organizations' gallery contents.

**Proposed:** curate three to five excellent starter canvases with actual use cases, useful cover images, and “Use this template” as a visible action. Make Gallery adapt gracefully to sparse content. Link to eligible templates from Create. Keep the existing org-scoped listing and clone-eligibility rules; do not broaden discovery or access to fill the page.

Reuse is the goal: open an example → clone a Restricted draft → adapt → publish and share intentionally. Put backend requirements on templates that need capabilities; cloning an example must not silently grant Connections or activate privileged features.

**Seams:** `routes/gallery.tsx`, `components/CanvasCard.tsx`, `components/CloneDialog.tsx`, existing examples and clone-eligibility resolver.

## Suggested sequence and acceptance

First round: homepage story and visual consistency; content-first Create and its success state; overview/action hierarchy. These touch the three strongest first-impression moments. Follow with library decluttering and quick-share. Curated starters can ship alongside the homepage; persistent pins, broader command search, and change comparison warrant separately scoped units.

Before implementation, convert selected scope into an approved plan and tracking issue. Reconcile stale design guidance: `PRODUCT.md`, `DESIGN.md`, the flat-editorial solution, and later skin conventions contain superseded typography, elevation, and navigation descriptions. Keep one current contract for implementation.

Validate with a few representative builders and viewers: explain the product after seeing the hero; publish a sample; find and update an existing canvas; grant one colleague access without widening the audience; restore an earlier version. Record completion, hesitation, and incorrect access predictions. Collect this through consented testing or approved instance-local evidence, preserving the no-phone-home promise.

Verify desktop and phone layouts, keyboard operation, reduced motion, light/dark, the supported skins, focus restoration, state transitions, and realistic long titles. Run relevant regression tests and the repository's full lint, typecheck, dual-dialect tests, review, and CI gates when feature code is implemented. No such implementation gates were run for this proposal.

Reference: Awwwards' published evaluation covers design, usability, creativity, and content (https://www.awwwards.com/about-evaluation/). The proposed signature interaction supports all four; award success itself cannot be predicted from a heuristic review.

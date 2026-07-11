---
title: Organization-scoped gallery listing - Plan
date: 2026-07-11
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
issue: 75
---

# Organization-scoped gallery listing - Plan

## Goal Capsule

- **Objective:** Make gallery listing one coherent owner action for eligible Whole-org canvases while preserving organization-scoped visibility and explicit opt-in.
- **Authority:** The user's approved behavior, then `BUILD_BRIEF.md` access/discovery invariants, then existing gallery and settings-service patterns.
- **Execution profile:** One autonomous branch and PR; merge only after local gates, code review, and required CI are green; deploy and verify from `main`.
- **Scope stop:** Do not broaden gallery eligibility to Team, Specific-people, Private, password-protected, unpublished, expired, or cross-org canvases.

---

## Product Contract

### Problem Frame

The gallery already scopes listed Whole-org canvases to authenticated members of the canvas's organization, but owners must first enable `List for people with access` and then separately enable `List in the gallery`. That dependency makes the gallery appear public-only and exposes an implementation distinction instead of the intended outcome.

### Requirements

- R1. Enabling gallery listing on a published, unprotected Whole-org canvas automatically makes it discoverable to members with access in the same atomic settings update.
- R2. Gallery listing remains an explicit owner opt-in and never follows automatically from choosing Whole org.
- R3. Whole-org gallery entries remain visible only to authenticated members in the canvas's home organization; Public-link gallery behavior remains unchanged.
- R4. Team, Specific-people, Private, unpublished, protected, expired, archived, disabled, and deleted canvases keep their current exclusions.
- R5. Dashboard copy distinguishes organization-scoped gallery visibility from public gallery visibility and no longer asks owners to satisfy a separate discoverability prerequisite.
- R6. HTTP and MCP callers receive the same behavior through `resolveSettingsUpdate`; no interface-specific implementation is introduced.
- R7. Authoring and architecture documentation describe gallery listing as the action that opts a Whole-org canvas into organization discovery.
- R8. A sparse gallery does not repeat the same canvases in a Recently published shelf and the Browse-all collection; the shelf appears only when it can summarize a larger collection.

### Acceptance Examples

- A1. Given a published Whole-org canvas with `discoverability='link_only'`, when its owner enables gallery listing, then one successful update persists both `discoverability='listed'` and `galleryListed=true`.
- A2. Given the same canvas, when an authenticated member of its home org browses the gallery, then it appears; a member of another org does not see it.
- A3. Given a Public-link canvas, when its owner enables gallery listing, then listing succeeds without changing its link-only discoverability value.
- A4. Given a Team or Private canvas, when gallery listing is requested, then the existing eligibility rejection remains.

### Scope Boundaries

- No new gallery surface, audience selector, schema, migration, or access rung.
- No automatic listing when Whole org is selected.
- No relaxation of the server-side gallery visibility predicate.

---

## Planning Contract

- KTD1. Normalize Whole-org gallery intent in `resolveSettingsUpdate`, because it is the shared service seam used by management HTTP and MCP and can persist both flags atomically.
- KTD2. Keep `discoverability` as the stored listability fact. Gallery listing implies `listed` for Whole-org canvases, while explicitly returning a listed gallery canvas to `link_only` continues to unlist it.
- KTD3. Simplify the dashboard blocker and use audience-specific copy; the backend remains authoritative for all publication, password, access, and tenancy checks.
- KTD4. Treat documentation as behavior-bearing because current docs explicitly teach the obsolete two-toggle dependency.

---

## Implementation Units

### U1. Normalize Whole-org gallery listing in the shared settings service

- **Goal:** Make `galleryListed: true` imply `discoverability: 'listed'` when effective access is Whole org, without changing any other access or listability invariant.
- **Files:** Modify `apps/server/src/canvas/settings-update.ts` and `apps/server/src/canvas/settings-update.test.ts`; strengthen route/MCP coverage where the existing suites expose the shared behavior.
- **Patterns:** Follow the existing effective-state calculation and invariant enforcement in `resolveSettingsUpdate`.
- **Execution note:** Update the existing NOT_DISCOVERABLE test into the new expected contract and observe it fail before implementation.
- **Test scenarios:** Whole-org link-only becomes listed atomically; Whole-org explicit gallery-plus-discoverability succeeds; Public-link stays link-only; Team and Private remain rejected; explicit downgrade to link-only still clears gallery/template flags; MCP and HTTP read back both fields.
- **Verification:** Focused settings, management, and MCP tests pass on the shared service chain.

### U2. Present gallery listing as an audience-scoped owner action

- **Goal:** Remove the dashboard's redundant Whole-org discoverability blocker and explain whether the listing is organization-scoped or public.
- **Files:** Modify `apps/dashboard/src/routes/canvas.share.tsx` and `apps/dashboard/src/test/share.test.tsx`.
- **Patterns:** Reuse `Toggle`, `InlineNotice`, optimistic settings mutation, and current Share-tab audience language.
- **Execution note:** Change the existing Whole-org blocker assertion first and observe the intended failure.
- **Test scenarios:** Whole-org link-only canvas can enable gallery listing; request contains gallery intent and the returned state shows both flags; copy says organization members can discover/open it; Public-link copy identifies public discovery; ineligible and protected states remain disabled.
- **Verification:** Focused dashboard Share tests and dashboard typecheck pass.

### U3. Update durable product and authoring documentation

- **Goal:** Remove the obsolete two-step instruction and record the shared-service implication for future changes.
- **Files:** Modify `BUILD_BRIEF.md`, `README.md` if needed, `docs/site/quickstart.md`, `docs/site/authoring/sharing.md`, and `docs/solutions/2026-06-24-shared-discovery-listability.md`.
- **Patterns:** Keep access and discoverability conceptually separate while documenting gallery listing as an explicit opt-in that also supplies Whole-org discoverability.
- **Test scenarios:** Documentation search finds no instruction requiring owners to pre-enable `List for people with access` before gallery listing; generated docs build succeeds.
- **Verification:** `pnpm build` and targeted text audit pass.

### U4. Remove redundant recency hierarchy from sparse galleries

- **Goal:** Keep Browse all as the only collection when the complete gallery fits within the six-card recency shelf.
- **Files:** Modify `apps/dashboard/src/routes/gallery.tsx` and `apps/dashboard/src/test/gallery.test.tsx`.
- **Patterns:** Preserve the existing unfiltered-grid discovery rules and `RECENT_CAP`; gate only the recency shelf, not Featured curation.
- **Test scenarios:** One-item and six-item galleries omit Recently published and Browse all headings; a seven-item gallery renders the capped recency shelf above Browse all.
- **Verification:** Focused Gallery view tests pass at the sparse and first-rich boundaries.

---

## Verification Contract

| Gate | Applies to | Done signal |
|---|---|---|
| Focused server and dashboard tests | U1, U2, U4 | New and existing gallery/settings/share scenarios pass |
| `pnpm lint` | U1-U4 | Biome reports no errors |
| `pnpm typecheck` | U1-U4 | All workspaces typecheck |
| `pnpm test` | U1-U4 | SQLite and PGlite suites pass |
| `pnpm build` | U1-U4 | SDK, dashboard, server, and generated docs build |
| `ce-code-review` | U1-U4 | All real P0/P1 and high-value P2 findings are fixed and regression-tested |
| GitHub CI matrix | U1-U4 | Required PR checks are green before merge |
| Production smoke | U1-U4 | Deploy from merged `main`; health and user-facing docs respond successfully |

---

## Definition of Done

- Whole-org gallery listing is one explicit action across dashboard, HTTP, and MCP.
- Organization boundaries and every existing gallery exclusion remain enforced by tests.
- Dashboard copy clearly communicates the effective audience.
- Product, authoring, and architecture docs agree with the shipped behavior.
- Sparse galleries render each canvas once instead of duplicating the complete set in a recency shelf.
- Issue #75 is closed by a merged green PR; the feature branch/worktree are removed; production is deployed and smoke-verified from `main`.

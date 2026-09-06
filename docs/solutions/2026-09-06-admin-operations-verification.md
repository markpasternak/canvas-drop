---
title: Admin operations implementation evidence
date: 2026-09-06
type: verification
area: admin
---

# Admin operations implementation evidence

Plan: [Admin investigation and operations](../plans/2026-09-06-001-feat-admin-operations-plan.md).
Tracking issue: [#114](https://github.com/markpasternak/canvas-drop/issues/114).
This is an implementation evidence ledger, not a completed-release claim.

## U1 — composable filters and saved table views

- Regression proof: the initial focused run failed seven assertions across SQLite,
  PostgreSQL, and HTTP because `false` meant absent and `not_expired` was missing.
- Added explicit negative boolean conditions end to end, including People filters.
  Configured public access is distinct from effective availability (published, active,
  unexpired, globally allowed, owner capability present). Password remains independent.
- Replaced exposure ID materialization with correlated SQL predicates; this also fixes
  filtering deleted canvases, previously omitted from the intermediate exposure list.
- Saved views persist validated filter/sort state locally per admin, preserve false,
  reject malformed stored values, and reset pagination. Optional columns and density
  preferences are also scoped to the signed-in user. Access detail badges are secondary
  to a readable summary.
- A full saved-view UI roundtrip exposed the shared search hook's competing effects:
  the old empty input could overwrite a restored URL query. Reconcile incoming query
  state before scheduling outgoing debounced navigation. The roundtrip now passes.
- Required gates: `pnpm lint`, `pnpm typecheck`, `pnpm test` passed on 2026-09-06.
  Full test result: 172 server test files passed, 2 skipped; 3,034 tests passed, 4
  skipped (external-infrastructure gates). Dashboard: 84 files / 740 tests passed.
  Server test harness runs both SQLite and PostgreSQL/PGlite. Real-infrastructure
  verification remains a required CI gate at delivery.
- Browser: local seeded dev instance on localhost:5173, named Playwright session
  `canvas-admin`. Visually inspected 1200×748 desktop and 390×844 mobile. Selected
  Password: No, then Effective public link: Yes; URL retained both conditions.
  Desktop and mobile screenshots captured locally; final integrated screenshots
  will be captured after the remaining units.

## U2 — activity and investigation

- Metadata-only inspector consolidates owner, access, direct/team grants, pending
  direct/team invitations, usage, Connections, and safe recent administrative events.
  Opening/closing preserves URL filters, page, scroll position and keyboard focus.
- Access explanations use the existing live role/access predicates, including domain
  membership rather than stale roster rows. Covered direct/team editors and viewers,
  password, expiry, unpublished/deleted lifecycle, blocked accounts, pending-only email,
  static-only public access, and organization boundaries on both database engines.
- Activity queries filter/count/page in the database. Legacy canvas events without
  target type are recognized only for known event names. Display metadata is explicitly
  allowlisted per action; raw payloads, hashes, credentials and client IPs are omitted.
- Required gates passed: lint, typecheck, full suite (172 server files / 3,046 tests;
  2 files / 4 external-infrastructure tests skipped; 84 dashboard files / 743 tests).
  Focused inspector tests prove context/focus restoration, access checks, error retry,
  activity date filters, pagination and navigation into the inspector.
- Browser: local sample canvas inspector opened from the bottom of the table; signed-out
  access check returned denial for whole-org access. Desktop and mobile screenshots
  captured in task-local output/playwright; private canvas content was never fetched.

## Remaining delivery evidence

U4–U6, review, final integrated verification, merge, deployment, and cleanup are still
required. Production has not been changed by this round.

## U3 — selected lifecycle operations and permanent purge

- Added bounded (50 selected IDs) preview/execute routes behind admin and same-origin
  gates. Confirmation includes operation and eligible count; a reason is mandatory.
  Lifecycle writes compare the preview timestamp atomically. Stale or ineligible items
  are skipped individually; selection never silently includes other matching pages.
- Additive migration 0039 on both dialects records purge start/completion. An atomic
  claim excludes concurrent restore, and partial cleanup never returns to service.
  New version creation, readiness, and publication reject a permanently claimed canvas.
  Online purge enforces 30-day retention and skips recent pending deployments; CLI
  maintenance shares cleanup and permanent state while retaining its operator-selected
  retention window. Pending work older than one hour is treated as abandoned.
- Cleanup removes all three storage namespaces (canvas blobs, uploads, previews),
  versions, drafts, screenshot jobs, uploaded-file records, KV, upload sessions, grants,
  legacy guest sessions/invitations, and canvas invitations. The canvas identity and
  audit history remain. Separate backups are outside the purge scope.
- Six initial new assertions failed before implementation. Focused tests now prove
  KV-only cleanup, partial storage failure/retry, retention, stale preview, restore race,
  real local-disk file removal, per-canvas hash isolation, and publication refusal.
- Required gates passed: lint, typecheck, full dual-dialect suite (173 server files /
  3,058 tests passed; 2 files / 4 external-infrastructure tests skipped); dashboard
  84 files / 745 tests passed. Generated migrations included and formatted.
- Browser: created only `Admin purge verification` on the isolated local instance,
  deleted it through the UI, aged only its fixture deletion timestamp, added three
  task-owned physical files, and confirmed purge in the UI. The preview counted three
  actual files. Direct filesystem verification confirmed all three were absent; the
  audit event recorded `objectsDeleted: 3` and the canvas remained a purged tombstone.
  Screenshot: task-local `output/playwright/admin-purge-preview.png`.

## User steering before release

After every feature is finished and verified, update the admin docs and marketing site
in this same branch/PR before deployment. Use finished-product behavior and real
screenshots, and explain deletion versus purge, retention, and backup boundaries.

## U4 — guided offboarding

- Metadata inventory covers owned canvases, live organizations, direct grants, teams,
  pending invitations, individual permits, and team creator responsibilities. A fingerprint
  rejects changed previews; each transfer rechecks ownership and successor eligibility.
- Confirmed execution blocks the account, revokes sign-in and MCP access/refresh tokens,
  reuses ownership reassignment, removes grants/memberships/invitations/permits, revokes
  remaining deploy keys, and reports partial failures and unresolved items with fresh retries.
  Team creator attribution and identity-provider membership require separate follow-up.
- Shared atomic administrator-removal logic protects the last usable administrator across
  offboarding, blocking, and demotion. Tests cover competing removals, stale inventory,
  live recipient eligibility, partial failure/retry, grants arriving during cleanup, and
  pending-only people. Route tests verify actual session/token revocation and origin gates.
- Required gates passed: lint, typecheck, 174 server files / 3,072 tests (four external
  infrastructure tests skipped), and 84 dashboard files / 747 tests. UI tests ensure the
  result stays visible even if the person disappears from the current filtered table.
- Browser verified local seeded Aisha's five-canvas handover to Dana, reason and exact
  confirmation, completion report, and blocked account. Production was not touched.
  Screenshot: task-local `output/playwright/admin-offboarding-preview.png`.

## U5 — Connections operations and actionable overview

- Complete-window SQL aggregates show 24-hour successes/failures, average latency,
  last success/failure, and distinct canvases with failures. Empty traffic and failed
  reads have distinct UI states. Named recent outcomes open the metadata inspector.
- Admin-only HEAD diagnostics reuse pinned egress, configured methods and protected
  headers, with no redirects, a five-second timeout, 32 KB response ceiling, and a
  per-profile ten-second cooldown. Only outcome/status/timing are returned and audited;
  probes do not become canvas traffic. Rotation guidance explains complete replacement,
  real-workflow verification, and upstream revocation of the previous credential.
- Needs attention contains incomplete purges and observed Connection failures or
  unavailable credentials. Routine public sharing, disabled canvases and elapsed
  retention are separate. Purge filters cover retained/eligible/incomplete/complete
  across the full dataset; completed tombstones no longer inflate cleanup backlog.
- A PostgreSQL grouped-JSON parameter mismatch failed the new test and was fixed by
  grouping on the selected expression's position. Migration 0040 adds the type/time
  event index on both dialects for the observed-window query.
- Required gates passed: lint, typecheck, 174 server files / 3,082 tests (four external
  infrastructure tests skipped), 84 dashboard files / 745 tests. Coverage includes
  profile isolation, absent traffic, safe fields, diagnostic limits/authorization,
  purge-state pagination, and failure-versus-routine overview semantics.
- Browser: local `Diagnostic verification` profile sent HEAD to `https://example.com`,
  returned HTTP 200 in 104 ms, retained `No recent traffic`, and showed no response body.
  Confirmed the overview's distinct exception and routine sections. Screenshots are
  task-local `admin-connections-diagnostic.png` and `admin-overview-operations.png`.

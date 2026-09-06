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

## Remaining delivery evidence

U2–U6, review, final integrated verification, merge, deployment, and cleanup are still
required. Production has not been changed by this round.

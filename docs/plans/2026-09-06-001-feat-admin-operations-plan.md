---
title: Admin investigation and operations
date: 2026-09-06
type: feat
execution: code
---

# Admin investigation and operations

## Goal and authority

Deliver the complete admin round authorized in the active goal: one isolated worktree,
`feat/admin-operations`, one PR, green review/CI, merge, established production deployment,
verified running release, and task-owned cleanup. No further approval checkpoint is needed.
The source baseline is `7e4ef71`. This plan records implementation decisions; evidence and
progress belong in commits, the tracking issue, and the final verification report.

## Scope and decisions

- R1: attention identifies actionable exceptions, separates normal activity, links to resolution.
- R2: metadata-only admin inspector preserves table context and consolidates owner, access,
  usage, Connections, and administrative history. No implicit admin content privilege.
- R3: person/canvas access explanation follows the live authorization predicates and explains
  owner/editor, direct/team grants, pending invitations, membership, blocking, public state,
  lifecycle, expiry, and password gates. It never impersonates or retrieves content.
- R4: searchable, paginated administrative activity by actor, canvas, action, and date.
  Audit metadata is allowlisted for display; keys, tokens, credentials, and request bodies
  cannot be exposed. Retain operational reasons and useful safe details.
- R5: offboarding preview lists ownership, memberships, grants, permits, and pending invitations.
  Execution revalidates targets, protects self/last admin, uses the existing ownership service,
  revokes access and tokens, and reports individual failures and unresolved ownership.
- R6: saved views and bulk administration with explicit selected-item scope, confirmation,
  bounded requests, per-item outcomes, and no silent action on unseen matches.
- R7: readable access summaries, optional columns, density choices, responsive table, and
  keyboard-accessible inspector/actions. Preferences are local, versioned, and user-scoped.
- R8: Connections health summaries from recorded events, named affected canvases, safe
  diagnostics through the existing pinned egress implementation, and credential-rotation help.
- R9: individual/bulk permanent purge from admin, previewed and confirmed separately from
  soft delete. Keep the audit tombstone. Reclaim versions, drafts, blobs, previews, files, KV,
  and associated runtime authority safely. Preserve other canvases' content-addressed data.
  Enforce retention eligibility and prevent deploy/restore races; retry incomplete cleanup.
  Production validation never purges existing production canvases.
- R10: ternary Any/Yes/No facets for password, effective public access, external access,
  invitations, templates, and listing. Configured access remains a separate selector.
  Expiry supports no expiry, expires later, expired, and not expired (including no expiry).
  All conditions are ANDed before pagination/counts. Preserve false in URL/API/cache keys;
  show removable conditions and save validated filters. Extend People booleans consistently.

Excluded: new budget/usage-reporting features and configuration-change preview/history.
No arbitrary backend execution, new tenancy model, or admin access to private content.
Dedicated cross-owner administration uses admin routes, per the existing MCP exception;
any owner-facing capability introduced must also use the same service through MCP.

## Implementation units

### U1. Composable filters and saved table views (R6, R7, R10)

Files: admin repository/routes/tests, dashboard API/router/query contracts, admin canvas/people
routes and tables, reusable admin filters/preferences components and tests.
Build ternary repository predicates, strict request parsing, full-dataset count/paging,
expiry boundary semantics, readable conditions, saved views, columns and density.
Tests first at repository/API seams: false versus absent, combined public/no-password,
revoked/global-off public state, no-expiry/not-expired, no external/pending, page boundaries,
malformed query rejection. UI tests prove URL serialization, removal, saved-view isolation,
preferences, reload/back navigation, and empty/error states.

### U2. Activity and investigation (R2, R3, R4)

Depends on U1. Files: audit/admin repositories and services, admin routes/wiring, inspector and
activity UI, typed API/query contracts, tests. Reuse role resolver and access decision services.
Test opaque non-admin denial, no secrets/content, actor/canvas/date filtering and paging,
every access gate including mixed direct/team roles, blocking, expiry, and invitation state.

### U3. Safe lifecycle and bulk operations (R6, R9)

Depends on U2. Files: purge/lifecycle/storage/deploy services and repositories as necessary,
admin routes, bulk/confirmation UI, migrations only if required, dual-dialect regression tests.
Inspect `2026-06-13-purge-vs-deploy-race.md` and harden its newly reachable concurrency seam.
Preview exact selected resources, explain retention and tombstones, revalidate before execution.
Test retention, confirmation, active-canvas refusal, deploy/restore races, KV-only canvases,
storage partial deletion, retry, shared blob isolation, stale selection, and non-admin denial.

### U4. Guided offboarding (R5)

Depends on U2/U3. Files: dedicated offboarding service, repository methods, admin routes/wiring,
People workflow UI and tests. Separate read-only impact preview from confirmed execution;
reuse ownership transfer rules, user blocking/token revocation, and grant mutation services.
Test multi-canvas ownership, org eligibility, self/last-admin protection, pending-only people,
team/direct access removal, retries, concurrent changes, and per-item partial failure reporting.

### U5. Connections operations and actionable overview (R1, R8)

Depends on U2. Files: Connections services/usage repository, admin routes, Connections and
overview UI, tests. Derive health only from observed request windows, label no data honestly,
provide bounded safe diagnostics and rotation guidance. Separate activity from exceptions;
each attention signal has an explanation and destination. Test failed upstreams, no traffic,
disabled profiles, secrets never returned, diagnostics restrictions and useful drill-downs.

### U6. Integration, review, delivery, and cleanup (all requirements)

Review the complete diff, simplify, run ce-code-review and fix substantive findings. Run
lint, typecheck, full dual-dialect/dashboard tests, build, and generated-document checks.
Browser-test desktop/mobile and representative multi-step workflows using local fixtures.
Capture screenshots and a requirement-by-requirement evidence report. Update BUILD_BRIEF
only to record the explicitly authorized admin scope, docs/site admin guidance, project status,
and relevant shared learnings; regenerate docs. Push/open one PR linked to the tracking issue,
wait for all required CI, squash merge and delete branch. Deploy from merged main through
the private `deploy/setup.sh deploy` procedure; verify server checkout, service health,
authenticated admin assets/endpoints, and representative read-only workflows. Preserve secrets.
Clean only this worktree/branch, owned temporary data and processes, after delivery verification.

## Verification and completion contract

Each unit receives focused behavioral tests followed by repository-required lint/typecheck/full
tests before its commit. CI must pass both dialects and real-infrastructure checks before merge.
No green subset substitutes for full workflow proof. Review findings and evidence are recorded
in `docs/solutions/2026-09-06-admin-operations-verification.md` before final delivery.
Completion requires every R1–R10 implemented, all U1–U6 gates satisfied, the single PR merged,
the merged release running in production, and task-owned cleanup verified. Missing runtime
evidence is incomplete work, not an inferred successful deployment.

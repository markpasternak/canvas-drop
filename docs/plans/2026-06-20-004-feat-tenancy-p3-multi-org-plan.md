---
title: "feat: Tenancy Phase 3 — multi-org readiness"
type: feat
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-multi-tenant-org-isolation-requirements.md
status: draft
depth: outline
phase: 3
depends_on: docs/plans/2026-06-20-003-feat-tenancy-p2-teams-plan.md
invariant_critical: true
---

# feat: Tenancy Phase 3 — Multi-Org Readiness (5 units, outline)

> **Outline depth** — re-planned in full when Phases 1–2 have shipped and a second org is real.
> Depends on the Phase 1 boundary + Phase 2 explicit membership. Invariant-critical: this is where
> "isolated from each other" must hold under hostile assumptions if the host faces the internet —
> a heavy security/adversarial `/ce-code-review` gates the PR.

## Summary

Flip the instance from "one configured org + guests" to "**several isolated orgs** on one
instance," operator-provisioned. Each org gets its own **subdomain** (`acme.host`) for
browser-origin isolation, its own gallery/members/teams (already org-scoped from P1/P2), and its
own **quotas**. Still invite-only and operator-provisioned (open signup is Phase 4).

## Problem Frame

After P1/P2 the data model is already org-scoped, but: (a) only one org is materialized (config
seeds it); (b) everything shares one browser origin; (c) limits are global/per-user. Phase 3
removes those three single-org assumptions.

## Requirements Traceability

| Requirement | Units |
|---|---|
| R10 Multi-org readiness (provisioning, subdomain isolation, quotas, multi-org membership) | U1–U4 |
| R13 Lifecycle (canvas reconciliation when a domain is removed / owner leaves) | U4 |
| R-sec Invariant tests | U4, U5 |

## Key Technical Decisions (provisional)

- **KTD1 — DB-led orgs; config seeds the first; the uniqueness invariant carries forward.**
  Additional orgs are created via an operator route/CLI (name + domains), not env. The P1 boot-upsert
  becomes "ensure the seed org exists"; beyond that, DB rows lead. **A domain still maps to at most
  one org** (the P1 `org_domains.domain`-unique invariant + boot guard) — provisioning a second org
  that claims an already-mapped domain is rejected; multi-org membership comes only from a future
  explicit-invite source, never a shared domain. Provisioning emits audit events.
- **KTD2 — Subdomain = the edge tenant selector; reconcile with the canvas URL mode; cookies must
  become host-scoped.** The existing `CANVAS_DROP_URL_MODE` (path vs subdomain) governs **canvas**
  isolation; org-subdomain is a **second** axis. Decide the composition: most likely **`{org}.host`
  for the dashboard/app + `{slug}.{org}.host` (or `{org}.host/c/{slug}`) for canvases** — pick one
  and make `resolveRequest` org-aware. Personal/guests live on the bare `host`. **Critical caveat:**
  the session cookie is `Domain=.{baseHost}`-scoped today (`auth/session.ts`), so `acme.host` and
  `globex.host` would **share** one cookie under the common parent — defeating the browser-origin
  isolation that is the whole point of this phase. P3 must issue **host-scoped (non-wildcard)**
  cookies per org-origin (or accept that org-subdomains under a shared parent are a UX/routing
  boundary, not a security one). Resolve in the U2 design doc — this is the sharpest hidden
  assumption in the subdomain axis.
- **KTD3 — Membership becomes multi-org.** A user may belong to >1 org (multiple matching domains
  or a future explicit invite). The principal carries a set (already true since P1); add an
  **active-org** notion for the dashboard workspace switcher and default scoping — and lift the P1
  one-org boot guard.
- **KTD4 — Per-org quotas (needs a usage rollup).** Move AI/storage/rate limits from global/per-user
  to **per-org** where it matters; keep per-user caps as a floor; per-org overrides live on the
  `orgs` row (admin-set in Phase 4). Counting an org's storage/AI means joining usage→canvas→org;
  add a **denormalized org rollup** (or an indexed `usage_events.org_id` / materialized counter) so
  quota checks don't re-join on every op — a P3 indexing decision to pre-note, not a P1 gap.
- **KTD5 — Isolation under load is a correctness property.** Every list/query must be org-scoped by
  construction; add a test harness that seeds two orgs and asserts **zero** cross-org bleed across
  every endpoint + MCP tool (the regression net for "isolated from each other").

## Implementation Units (outline)

1. **U1 — Multi-org provisioning.** Operator route/CLI to create orgs + map/verify domains; the
   seed org keeps working; audit + tests.
2. **U2 — Subdomain-per-org routing + origin isolation.** Org resolution at the edge; reconcile
   with the canvas URL mode; **host-scoped (non-wildcard) cookies** per org origin + CSRF/CSP
   scoping (KTD2); preserve the proxy-mode posture. (Own design doc — the URL + cookie wrinkle.)
3. **U3 — Per-org quotas/limits.** Per-org AI/storage/rate config + enforcement + the usage rollup
   (KTD4); per-user floor retained.
4. **U4 — Multi-org membership + active-org + lifecycle reconciliation (R13).** Membership as a set;
   active-org selection; lift the P1 one-org boot guard; cross-org leak hardening. **Canvas
   reconciliation:** when a domain is removed (a member becomes a guest) or an owner leaves the org,
   decide and implement what happens to their org-home canvases — surface "stranded" org canvases in
   the now-guest's Personal view, and/or reconcile `org_id`→null with a `whole_org`→`private` clamp,
   with a dry-run delta like the P1 cutover. Pin org-canvas **ownership reassignment** for a departed
   owner (the P1 owner-bypass otherwise leaves a departed owner editing org content).
5. **U5 — Two-org isolation test harness + review.** Seed two orgs; assert zero cross-org bleed on
   every endpoint + MCP; heavy security/adversarial `/ce-code-review`.

## Risks

- **Origin model is the crux.** Getting subdomain composition wrong undermines the browser-level
  isolation that justifies Phase 3 — do the design doc before code.
- **Quota migration.** Moving limits to per-org without a per-user floor could regress a shared
  small-VPS deploy; keep both.

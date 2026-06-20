---
title: "feat: Tenancy Phase 4 — open to the internet (public SaaS)"
type: feat
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-multi-tenant-org-isolation-requirements.md
status: draft
depth: outline
phase: 4
depends_on: docs/plans/2026-06-20-004-feat-tenancy-p3-multi-org-plan.md
invariant_critical: true
---

# feat: Tenancy Phase 4 — Open to the Internet (5 units, outline)

> **Outline depth** — re-planned in full only if/when you decide to face the public internet.
> Depends on Phase 3 (multi-org + origin isolation). This is the phase that breaks the "trusted
> colleagues, not hostile public internet" calibration in
> `docs/solutions/2026-06-13-auth-invariant-checklist.md` — the threat model **changes**, so prior
> "right-sized" findings must be re-weighted as genuinely hostile. A full security review + an
> external pen-test pass are gates.

## Summary

Turn the operator-provisioned multi-org instance into a **self-serve public SaaS**: anyone can
claim an org (by proving domain ownership), guests can self-sign-up (behind abuse controls), and
each org gets a **per-org admin** with a console to run their own org. This flips the two toggles
deferred since Phase 1 (D8 open signup, D10 per-org governance).

## Problem Frame

Phases 1–3 assume the operator vouches for who gets in. Going public removes that human gate, which
(a) invites abuse (spam orgs, throwaway signups, resource exhaustion) and (b) demands real per-org
self-administration. The data model is ready; the **trust model** is what changes.

## Requirements Traceability

| Requirement | Units |
|---|---|
| R11 Public-facing (domain claim, signup toggle + abuse controls, per-org admin console) | U1–U4 |
| R-sec Invariant tests (now hostile-internet weighted) | U5 |

## Key Technical Decisions (provisional)

- **KTD1 — Verified domain claim.** An org owner proves domain ownership (DNS TXT record or an
  email challenge to a same-domain address) before the domain → org mapping is trusted. No
  unverified domain ever grants membership.
- **KTD2 — Signup is a toggle with teeth.** `CANVAS_DROP_ALLOW_SELF_SIGNUP` flips guest self-signup
  on; it ships **with** abuse controls, never before: email verification, IP/account rate limits,
  per-new-account resource caps, and an operator kill-switch. Invite-only remains the default.
- **KTD3 — Per-org admin role + console.** The RBAC deferred since Phase 1 lands here:
  `org_members.role ∈ {owner, admin, member}`; an org-admin console for members, teams, domains,
  quotas, and billing — scoped strictly to the admin's own org. The instance operator stays
  super-admin.
- **KTD4 — Metering/billing hooks (optional, business-model-dependent).** If monetized, per-org
  usage metering already exists (P3 quotas); add billing integration points. Left as a stub —
  out of scope unless you choose to monetize.
- **KTD5 — Re-weight the whole §12 surface as hostile.** Every "an attacker could…" finding that
  was a P3 note under the trusted-colleague model is re-triaged now; the hard invariants were
  always absolute, but the proportionate layer tightens.

## Implementation Units (outline)

1. **U1 — Self-serve org claim** (DNS TXT / email domain verification; claim flow + audit).
2. **U2 — Guest self-signup toggle + abuse controls** (email verification, rate limits, per-account
   caps, kill-switch).
3. **U3 — Per-org admin role + console** (owner/admin/member; org-scoped admin surface; MCP parity
   for org-admin actions that are owner-facing).
4. **U4 — Billing/metering hooks** (optional stub; only if monetized).
5. **U5 — Hostile-internet review + pen-test** (full security/adversarial `/ce-code-review`
   re-weighted to the public threat model; external pen-test pass; abuse + isolation load tests).

## Risks

- **Threat-model flip.** The biggest risk is treating Phase 4 like Phases 1–3 — it isn't. The
  trust calibration that justified proportionate hardening no longer applies; budget for real
  abuse-resistance work.
- **Signup abuse.** Open signup without the U2 controls is the classic way a small instance gets
  turned into spam/compute. The toggle must be inseparable from its guardrails.
- **Support/ops surface.** Per-org self-admin multiplies the support surface; size the ops story
  (the M10 backup/restore + load-test work is a prerequisite for facing the internet).

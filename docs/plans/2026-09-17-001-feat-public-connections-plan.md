---
title: Opt-in public Connections
date: 2026-09-17
type: feat
---

# Opt-in public Connections

## Goal and authority

The user approved adding opt-in public Connections to Canvas Drop, enabled only for Margin initially. Anonymous visitors must be able to analyze a draft on Margin while the TypeSafe credential remains server-side. This explicitly extends the previous blanket static-only rule for this bounded capability. Other primitives remain inaccessible to public-link visitors.

## Contract

- Default remains off for every canvas/profile grant. An administrator configures public access on an existing grant, with exact upstream paths, a subset of profile methods, and a positive daily request cap. Profile host/credentials, grant, lifecycle, password gate, backend switch and cross-canvas isolation retain their existing authority.
- Public callers can only invoke that connection and read its minimal invocation status. They receive no identity, KV, files, AI, realtime or authoring access. The status API avoids minting an anonymous identity or widening `me()`.
- Public requests retain transport address validation, header protection, size/time bounds and concurrency limits. A server-derived, hashed client IP supplies the anonymous rate-limit actor. A database-atomic daily counter on the grant survives process restart and parallel requests. The cap limits request count, not currency spend.
- Public requests cannot follow upstream redirects into unapproved paths. Queries are not accepted on public routes in the first release. Every allowed path is exact and canonical.
- Signed-in owner/editor and invited-viewer behavior is preserved. Admin-only controls use the same service layer as HTTP. Manager/MCP listing reports sanitized public policy; no new owner write action is added. Admin-only actions remain exempt from per-account MCP parity under AGENTS.md.
- Margin alone initially: TypeSafe profile, POST `/v1/systemone`, daily cap 2,000 requests, existing minute/concurrency limits. Roughly 40–50 reference-sized analyses fit this cap; real usage depends on document size. The key never reaches the browser.

## Implementation units

### U1 — Grant policy and admission

Add nullable public policy plus durable daily-counter fields to both database schemas and additive migrations. Extend connection service/admin HTTP routes with validated, audited updates and sanitized listing. Add rejection-first policy, quota concurrency/reset and secret-redaction tests on both dialects.

### U2 — Runtime and client

Carve out only Connections invocation/status routes from static-only rejection. Recheck live grant and policy on every request, enforce method/path/body/redirect/quota constraints and retain isolation middleware. Add SDK status API, admin UI grant controls and tests. Keep all unrelated primitives denied, including encoded route/path bypass attempts and lifecycle changes.

### U3 — Delivery and Margin

Update spec/docs for the narrow exception and capture implementation learnings. Run lint, typecheck, full dual-dialect/dashboard tests, build and code review. Ship through green CI and a PR; deploy with backup and readback. Enable only Margin through the admin API. Update Margin to use connection status, deploy its bundle, and verify anonymous score/highlights/editing prompt plus non-granted primitive denial.

## Verification and completion

Pass existing signed-in connection tests and new anonymous allow/deny, cross-canvas, missing/disabled grant, blocked account/expired/private/password/backend-off, exact-path/method, protected-header, redirect and concurrent daily quota tests. Public status must reveal only effective invocation information. Confirm existing grants migrate disabled. Full repository gates and CI must pass before merge. Production completion requires an actual anonymous TypeSafe analysis and a durable record that only Margin has a public grant.

Implementation runs inline, sequentially, following the user's tool mapping. The checkout was clean at `3327659`; work lives in `feat/public-connections` in a separate worktree. No pre-existing changes are included.

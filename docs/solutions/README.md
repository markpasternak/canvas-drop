# docs/solutions — compounding learnings

This directory is the **shared brain** for every agent (Claude, Codex) and human on canvas-drop. It's how knowledge compounds across parallel work.

Each file is one learning with frontmatter so `ce-learnings-researcher` can surface it before related work:

```markdown
---
title: SQLite stores JSON as TEXT, Postgres as jsonb — round-trip carefully
type: bug            # bug | architecture | design | convention | workflow
area: data           # config | data | storage | routing | auth | ops | ...
date: 2026-06-13
---

What happened, the root cause, and how to avoid it next time.
```

## How to add one

- Run `/ce-compound` after solving something non-obvious — it writes the file for you.
- Or add a markdown file by hand following the shape above.

## Why it matters here

Claude Code's private per-project memory is **not shared with Codex**. Anything two agents both need to know lives here, in git. Keep PRs small and merge often so a learning written on one branch reaches the other agent quickly.

## Index

- [Dual-dialect Drizzle seam + pglite testing](2026-06-13-dual-dialect-drizzle-seam.md) — per-dialect schemas, the typed `any` repo seam, atomic upsert, `ping()` on DbClient, index/FK parity, pglite for the PG test leg, migration-folder resolution.
- [Auth/security invariant checklist](2026-06-13-auth-invariant-checklist.md) — **read before any auth/permission work.** The §12 failure modes (dev-in-prod, /0 CIDR, JWKS downgrade, XFF-spoofed IP, upsert race) a multi-agent review caught past self-review, plus a reusable checklist.
- [CI + test-infra gotchas](2026-06-13-ci-and-test-infra-gotchas.md) — pnpm native-build approval, pglite vs real PG, MinIO-as-a-step in Actions, dialect-split, Biome import-sort, private-repo branch-protection limits.
- [Canvas hosting + deploy patterns](2026-06-13-canvas-hosting-deploy-patterns.md) — the authorization decision-table, the three auth paths, the deploy engine (streaming yauzl, atomic swap, retry, prune), serving, and the small-VPS resource defenses. Read before area E/F–R.
- [Dashboard SPA (area E) patterns](2026-06-13-dashboard-spa-patterns.md) — **read before dashboard / serveSpa / management-UI work.** The `/c/` route collision (use `/canvases/`), serveSpa traps (module-relative dist, missing-asset 404, malformed-URL), the auth-expiry contract, the optimism `canvas.id`-seed gotcha, token re-skin contract, designed error-page brand contract, sqlite-only route tests, and the deferred rollback-vs-prune race.
- [Content-addressed blobs + draft/publish (M5)](2026-06-13-content-addressed-draft-publish.md) — **read before storage / pruning / editor work.** Per-canvas blob keying, version=manifest, the dedicated `drafts` table, publish-as-manifest-op, two-phase pruning (rows vs mark-sweep GC), the accepted blob-GC race, `stale` in the engine seam, dashboard-origin preview, and the raw-file auth-expiry gotcha.
- [Canvas capability model (plan 006)](2026-06-13-canvas-capability-model.md) — **read before primitive (KV/files/AI/realtime/identity) work.** Per-canvas backend toggles, the `effective = backend AND flag AND operator-global` rule, the `requireCapability` guard seam, identity-implies-backend, sub-toggles-persist (KTD-2), API-key-decoupled (KTD-5), the optimistic-UI-must-not-turn-gated-features-on gotcha, and the dashboard-mirrors-the-taxonomy gotcha.
- [Canvas primitives runtime API (plan 007 / M6)](2026-06-13-canvas-primitives-runtime-api.md) — **read before AI/realtime (M9) or KV/files/usage work.** The `/v1/c/:slug` seam pipeline (gateway → resolve+authorize → password gate → Origin/CORS+Sec-Fetch-Site isolation → requireCapability), the transaction-free dual-dialect KV atomic increment (CAST AS REAL not INTEGER), the served esbuild SDK (DOM tsconfig, behind the gateway, detectContext port, absolute upload url), the `{code}` error envelope, and per-op metering + retention prune.
- [Admin panel + rate limiting + §12.5 hardening (M7)](2026-06-13-admin-and-rate-limit-hardening.md) — **read before admin-surface, rate-limit, or takedown work.** Server-resolved `isAdmin` + 404-no-leak; the cross-owner read is the only owner-scope exception; the disabled state is authoritative (admin not exempted, two laundering paths closed — archive AND delete→restore); one path-first rate-limit classifier with server-derived keys + in-process store that never evicts a live bucket; the security-headers helper-vs-middleware split; audit-vs-metering; keyset on UUIDv7 id not created_at; the §12.5 JWT-failure stray-header log.
- [Gallery listing patterns (M8)](2026-06-13-gallery-listing-patterns.md) — **read before gallery or any cross-owner read surface.** The §12 read predicate (incl. the easy-to-miss `current_version_id IS NOT NULL` dead-link guard), explicit owner projection + exact-key leak assertion, the dual-dialect JSON tag-membership query (and the pg `@> JSON.stringify([tag])::jsonb` bind trap), the no-index/two-query-count scale decision, and the `keepPreviousData` + reset-effect spurious-reset trap (`!isPlaceholderData` gate).
- [Clone a canvas as a template (plan 002)](2026-06-14-clone-as-template.md) — **read before cloning, gallery, or storage-copy work.** Clone = seeding-manifest pick (published, else draft) + per-canvas blob copy via the new `StorageDriver.copy` (S3 CopyObject) + draft seeded verbatim; reset-vs-carried matrix (carries password hash+version & lineage, resets owner/slug/key/sharing/gallery, copies no runtime data); gallery listability tightened to **published + unprotected** (reverses the M8 "protected is listed" decision) with one shared predicate reused by `listGallery` and `findCloneableTemplate`; `templatable ⊆ listed` invariant; and why clone lives on the HTTP endpoint, NOT the runtime SDK.
- [Parallel-agent isolation gotchas](2026-06-14-parallel-agent-worktree-isolation.md) — **read before running parallel-agent rounds.** A bare task slug makes two agents reuse the SAME worktree/branch (clean `git status` ≠ unowned — agents sit between commits); name with the `-n<N>` suffix and treat an existing worktree/branch as another live agent. Plus: `.env` is NOT auto-loaded (12-factor; prod uses systemd `EnvironmentFile`), so export `CANVAS_DROP_*` on the `pnpm dev` command or Vite `strictPort` crashes on the default 5173.
- [useInfiniteQuery + keyset pagination dedupe](2026-06-14-infinite-query-keyset-pagination.md) — **read before infinite-scrolling a keyset list in the dashboard.** v5 refetches each loaded page with its STORED cursor (not via getNextPageParam), so a concurrent dataset shift makes keyset pages overlap → duplicate React keys (or a silently skipped row). Dedupe the flattened pages by id (first-wins); type the cursor as `string` (the row id), not `number`. First seen in the M7 admin canvas list (PR #26).
- [Admin-managed config (DB-over-env) + SDK dev-build gotcha](2026-06-14-admin-managed-config-and-sdk-dev-build.md) — **read before admin-config, served-SDK, or editable-setting work.** The served SDK 503s under `pnpm dev` until `packages/sdk` has a watch `dev` build; "editable in the panel" must trace override→effective-resolver→enforcement (the AI USD quota shipped editable-but-unenforced — KV/files read `effectiveQuota`, AI didn't); the config registry (one descriptor, DB-override ?? env ?? default, `presentEnvVars` source attribution); secrets are write-only with `last4` ONLY for editable secrets (read-only env secrets expose `set` only); runtime-tunable globals resolve per request (capability gate/provider/`effective` view); auth/rate-limit knobs stay read-only in the panel (§12 hot path).
- [AI proxy + Realtime primitives (plan 009 / M9)](2026-06-13-ai-realtime-primitives.md) — **read before AI/realtime/quota/WS work.** The one-file Vercel-AI-SDK provider seam (+ the otel→double-drizzle-orm install trap), code-owned pricing + UTC quota windows + the abandoned-stream quota-leak `finally`, the SSE `{type}` envelope, the WebSocket handshake-auth-vs-capability-4403 split (`@hono/node-ws` runs the full middleware on the upgrade; WS targets the **base** host), the in-memory hub (protocol in `handleMessage`, structural cross-canvas isolation), revoke-drops-socket (instant hooks on the real mutation handlers + 60s heartbeat), and the real-socket WS integration-test pattern.

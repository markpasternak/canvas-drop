---
title: Admin-managed config (DB-over-env) + the SDK dev-build gotcha
date: 2026-06-14
tags: [config, admin, secrets, sdk, dev-experience, ai, capability]
problem_types: [architecture, gotcha, bug]
areas: [apps/server/src/admin, packages/sdk, apps/server/src/routes/canvas-ai.ts]
---

# Admin-managed configuration (DB overrides env) + the served-SDK dev-build gotcha

Learnings from the showcase + admin-config round (plan 002).

## 1. The served SDK 503s under `pnpm dev` unless it has a watch build

Any canvas using `<script src="/sdk/v1.js">` gets a **503** in dev until the SDK
bundle exists on disk. `serve-sdk.ts` reads `@canvas-drop/sdk/bundle`
(`dist/sdk.v1.js`), but `pnpm dev` runs `pnpm -r --parallel dev` and the SDK
package only had a one-shot `build` (no `dev`). So the bundle was never produced
in dev and every primitive call from a canvas failed before this round.

**Fix / pattern:** give `packages/sdk` a watching `dev` script
(`esbuild … --watch`) so the parallel dev runner produces + rebuilds the bundle.
The serve route already re-checks disk on each request when the cached load was
empty, so once esbuild writes the file the next request succeeds with no restart.
**If you add another browser-served built artifact, give it a `dev` watch too.**

## 2. "Editable in the panel" must mean "actually enforced" — the AI quota trap

When you surface a setting as editable in an admin UI, the override has to reach
the enforcement point. The AI **USD quotas** were displayed + persisted as
editable, reported `source: database`, but `canvas-ai.ts` read
`config.ai.userDailyUsd` **directly** — never `effectiveQuota(...)`. So an admin
lowering the cap to stop runaway spend would believe it took effect while the old
cap was still enforced. KV/files quotas were correct (they read `effectiveQuota`);
AI was the gap because its route never consumed the resolver.

**Rule:** for every editable setting, trace override → effective-resolver →
the consumer that enforces it, and add a test that a DB override changes the
observable behavior (here: the 429 boundary). If you can't wire enforcement
cleanly, mark the field **read-only** rather than ship an editable no-op.

## 3. Config registry: one descriptor, one resolution rule

`admin/config-fields.ts` is the single source of truth: each setting is one
descriptor (`env`, `group`, `secret`, `editable`, `fromConfig`, `settingKey`).
Resolution is uniform everywhere: **DB override (editable only) ?? env ??
built-in default**. `presentEnvVars()` (the *only* other `process.env` reader,
living in the config module per §8.1) attributes source (database/environment/
default). The same registry drives the read view (`describeConfig`) and the write
path (`setConfigOverride`), so they can't drift.

## 4. Secrets: write-only, and last4 only for editable secrets

A DB-stored secret (the AI provider key) must be **write-only** — never
serialized to any response, log, or the SDK bundle. `describeConfig`/the admin
`/config` GET emit only `{ set, last4 }` for secrets, never the value. Crucially,
expose `last4` **only for editable secrets** (a confirmation aid for a key you set
here). Read-only env secrets (session secret, DB URL, OIDC/S3 secrets) expose
only `set: true` — no fragment of a secret you can't manage here should leak,
even to an admin. (Two reviewers flagged the over-broad last4 independently.)

## 5. Runtime-tunable globals → resolve per request, not at boot

The AI key + capability now resolve **per request** (admin can set/rotate the key
with no restart). `requireCapability` gained an optional async globals override so
the AI gate reads the effective key live; the provider is built per call from the
effective key; `management`'s `effective` capability view resolves it too.
Per-request settings reads are a documented, accepted cost at trusted-org
single-process scale (a PK lookup on a ~10-row table) — no cache.

## 6. Security/auth knobs stay read-only in the web panel

Admin emails, allowed email domains, and rate limits are shown for transparency
but are **read-only** this round — they're read on the auth + rate-limit hot paths
(§12 invariant surface), and live-editing them is a lockout/security footgun.
Make them editable only behind dedicated auth tests + a security review.

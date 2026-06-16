---
title: Security audit — whole-app review
date: 2026-06-16
method: security-audit workflow (.claude/workflows/security-audit.js)
scope: 13 server-side security surfaces, ~16k LOC (apps/server/src + packages/shared config)
agents: 16 (1 threat-model + 13 surface reviewers + verifiers + 1 synthesis)
principle: code is the source of truth; spec is a hint; trusted-org threat model
---

# Security audit — 2026-06-16

## Posture: strong

No hard-invariant breaks were confirmed in code — **no impersonation, no
cross-user/cross-canvas theft, no unauthorized access, no lifecycle-enforcement
gaps**. Realtime attribution comes from the server-resolved identity, every op is
scoped to the handshake `canvasId`, and access/lifecycle is re-validated.

Every finding was adversarially verified against the **actual code** (spec-only
mismatches were refuted and dropped) and calibrated to the trusted-org threat
model (§12.0 hard invariants stay high; accident/resource concerns on
non-invariant surfaces deflate).

| Severity | Count |
|----------|-------|
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |
| P3 | 1 |
| Open questions (owner adjudication) | 3 |

**Only actionable finding:** `sec-001` — meter non-publish realtime frames and
cap per-connection channel subscriptions. Everything else is a design/
deployment-dependent decision (open questions below).

---

## Findings

### sec-001 — Non-publish realtime frames are unmetered & per-connection channels are uncapped — **P3** (dos, confirmed)

**Surface:** Realtime hub & presence
**Location:** `apps/server/src/realtime/hub.ts`
- `:163-177` — `rateLimited` applied only in `doPublish`
- `:130-148` — `doSubscribe` adds to unbounded `conn.channels` with no cap
- `:248-273` — `handleMessage` switch processes `subscribe`/`unsubscribe`/`presence` without rate limiting

**Description.** The per-connection sliding-window rate limiter (`rateLimited`,
`MAX_MESSAGES_PER_MIN=100`, `RATE_WINDOW_MS=60s`) is invoked only inside
`doPublish` (`hub.ts:174`). The `subscribe`, `unsubscribe`, and `presence` frame
branches in `handleMessage` (`hub.ts:248-273`) are processed with no rate limit.
Separately, `doSubscribe` (`hub.ts:130-148`) adds the channel to `conn.channels`
— an unbounded `Set` — with no per-connection channel-count cap. A single
authorized connection can therefore (a) send unlimited `subscribe` frames to
distinct arbitrary channel strings, growing `conn.channels` without bound (memory),
and (b) send unlimited `presence` frames, each calling `presence()`/`subscribers()`,
which iterate every connection on the canvas (CPU). Frames are capped at 16KB
(`MAX_MESSAGE_BYTES`) and must be valid JSON, but nothing caps frames-per-minute
for these types.

**Why P3 (not higher).** Within-canvas, authenticated-colleague resource
exhaustion on a small VPS. It does **not** amplify across other users (join
broadcasts for unique channels reach only the attacker's own subscription) and
does **not** cross canvas boundaries. No hard invariant is broken: attribution
comes from server-resolved `conn.user` (no impersonation), every op is scoped to
the fixed handshake `canvasId` (no cross-canvas reach), and access/lifecycle is
enforced by `revalidateCanvas`/`dropConn`. This is the accident/resource-safety
tier — light defense-in-depth, not mandatory hardening.

**Exploit scenario.** An org member opens a WebSocket to
`/v1/c/<their-canvas>/realtime` (passes auth). In a tight loop the client sends
`{"type":"subscribe","channel":"<random-unique-string>"}` frames as fast as the
socket allows. None hit the publish rate limiter, so `conn.channels` grows
unboundedly; repeating across the 30 allowed connections per canvas
(`MAX_CONNECTIONS_PER_CANVAS`) multiplies it. Alternatively a flood of
`{"type":"presence","channel":"x"}` frames forces repeated full scans of the
canvas's connection set. On a single small droplet this can degrade or OOM the
process.

**Suggested fix.** In `hub.ts`:
1. Route the `subscribe`, `unsubscribe`, and `presence` branches in
   `handleMessage` (lines 249-269) through the existing `rateLimited(conn, now)`
   sliding-window check (or a separate, slightly higher cap), emitting the same
   `{type:"error",code:"RATE_LIMITED"}` frame on trip — reuse the `conn.sends`
   window pattern from `doPublish`.
2. Add a `MAX_CHANNELS_PER_CONNECTION` constant and enforce it in `doSubscribe`
   (line 130): when `conn.channels.size >= cap` and the channel is not already
   present, reject with an error frame (e.g. `{type:"error",code:"CHANNEL_LIMIT"}`)
   instead of adding to the `Set`.
3. Add a regression test that floods `subscribe`/`presence` frames and asserts
   the limiter trips and the channel cap is honored.

---

## Open questions (owner adjudication — not findings)

These are security-relevant divergences where the code is defensible but the
intended behavior depends on a deployment or design decision only you can make.
None are confirmed code holes.

### OQ-1 — Should the OIDC callback require `email_verified === true` before trusting the `email` claim for the org-domain allowlist?

**Where:** `apps/server/src/auth/identity-mapping.ts:13-23` (`claimsToIdentity`),
`apps/server/src/auth/oidc.ts:113-115` / `completeLogin:144`

`claimsToIdentity` accepts any `email` claim with no `email_verified` check, and
`isEmailAllowed` authorizes purely on the email's domain. With a strict org IdP
(e.g. Google Workspace, which only emits verified emails for its own domain) this
is safe and the trust model assumes it. But canvas-drop's OIDC config is a
generic issuer/clientId/secret — against a permissive provider that lets a user
self-assert an arbitrary unverified email, a user could set `email` to
`someone@alloweddomain.com` and pass the allowlist, gaining org-member access.
Whether this matters depends entirely on the deployed IdP. Adding
`if (claims.email_verified === false) reject` is cheap defense-in-depth but may
be redundant for the intended IdP.

**Decision needed:** Is canvas-drop only ever deployed against IdPs that emit
verified emails for the allowlisted domain? If not (or to be safe regardless),
add the `email_verified` guard.

### OQ-2 — Are guest session emails normalized (trim + lowercase) the same way as allowlist entries?

**Where:** `apps/server/src/canvas/authorization.ts:149`
(`principalLookupKey`/`isPrincipalAllowed`) vs
`apps/server/src/routes/management.ts:571-576` (`allowlistAddSchema` lowercases email)

Allowlist entries are normalized to trimmed-lowercase at write time.
`isPrincipalAllowed` does an exact `eq()` match on the guest principal's email.
If a guest session ever carries a non-normalized email (e.g. mixed case from the
OIDC/invite path), the match **fails** and a legitimately-invited guest is
**denied** access. This is fail-safe (deny, not over-grant) — not a security
finding and not an invariant break — but it could be a correctness/availability
bug worth confirming.

**Decision needed:** Confirm guest principal emails are normalized identically at
every comparison site (or normalize on read in `isPrincipalAllowed`).

### OQ-3 — Should stored file MIME be re-validated/normalized server-side, or is verbatim trust of client-supplied `file.type` acceptable?

**Where:** `apps/server/src/routes/canvas-files.ts:51` (`mime` from `file.type`)
→ `apps/server/src/canvas/file-serving.ts:38` (`safeServeHeaders`)

The stored `mime` originates from the client-supplied multipart `file.type` and
is echoed verbatim as `Content-Type` on serve. This is **defensible as-safe**:
`file-serving.ts` always sets `X-Content-Type-Options: nosniff` and only sets
`Content-Disposition: inline` for a strict raster allowlist
(`png/jpeg/gif/webp/avif`, excluding `image/svg+xml`); everything else (incl.
`text/html`, `image/svg+xml`) is forced to `attachment`. So a malicious
bytes+mime pair cannot achieve script execution in the canvas origin (`nosniff`
blocks reinterpretation; an HTML-bytes-as-`image/png` upload renders as a broken
image, not script). The residual is purely a consistency question.

**Decision needed:** Do you want the stored mime authoritatively normalized at
upload (e.g. via `mime.ts`) for consistency? Not exploitable on the trust model —
a design preference, not a fix.

---

## Surfaces reviewed (13)

auth gateway · proxy trust / client-IP · OIDC + session · guest/public/magic-link
· canvas authorization · static-serve/files/storage-keys · KV/files/me primitives
· AI proxy (key secrecy + quota) · realtime hub · deploy ingest (zip-bomb /
owner-guard) · admin authz · HTTP hardening (CSRF/headers/rate-limit) ·
config + secrets reader.

## To fix these

Re-runnable via the `security-audit` workflow
(`.claude/workflows/security-audit.js`). Findings here carry stable IDs
(`sec-NNN-…`) so a fix workflow can iterate over them. For this run, the only
code change is `sec-001`; OQ-1/2/3 need a decision from you first.

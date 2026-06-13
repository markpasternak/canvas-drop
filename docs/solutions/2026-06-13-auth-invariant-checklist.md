---
title: Auth/security invariant checklist — the §12 failure modes a multi-agent review caught that self-review missed
type: bug
area: auth
date: 2026-06-13
---

The foundation's auth gateway passed self-review and 108 green tests, then a
9-persona `/ce-code-review` found a **P0 and four P1 security/reliability bugs**
in it. Read this before touching auth, proxy trust, sessions, or config guards —
these are the exact traps, with the fix shape. See also [[dual-dialect-drizzle-seam]].

## The bugs that shipped past self-review

1. **`dev` auth mode had no production guard.** `dev` auto-logs-in a fake admin
   AND is the schema default, so a prod deploy that forgot to set
   `CANVAS_DROP_AUTH_MODE` authenticated every anonymous request as bootstrap
   admin. **Fix:** a `superRefine` issue rejecting `dev` + `NODE_ENV=production`.
   *Lesson:* any "convenience" default that weakens security needs an explicit
   prod boot guard — the default is the dangerous case, not the configured one.

2. **`0.0.0.0/0` was accepted as a trusted-proxy CIDR.** `bits===0` → mask 0 →
   matches every source IP, silently turning the §12.5 anti-impersonation gate
   into a no-op. **Fix:** validate every `CANVAS_DROP_TRUSTED_PROXY_IPS` entry at
   boot (reject `/0`, malformed v4, unsupported v6) AND reject `/0` in the
   runtime matcher (defense in depth). *Lesson:* a security control that reads a
   list from config must validate every entry — a permissive entry disables it.

3. **JWKS → header trust downgrade.** When both JWT-JWKS and trusted-IP header
   were configured, a request that *omitted* the JWT fell through to the weaker
   header path. An attacker just doesn't send the JWT. **Fix:** the two proxy
   trust paths are mutually exclusive — when JWKS is configured it is the ONLY
   path; no fall-through. *Lesson:* layered auth paths must not compose as a
   fallback chain; the attacker picks the weakest link.

4. **Trusted-proxy IP read from `X-Forwarded-For`** (caught in the *first*
   self-review, before the panel). The IP that gates header-trust must be the
   real TCP socket peer (`@hono/node-server/conninfo`), never a client-settable
   header. *Lesson:* "the client's IP" is only trustworthy from the socket.

5. **`users.upsert` was a read-then-write race.** Two concurrent first-logins
   for the same identity both INSERT → the second 500s on the unique constraint,
   and the gateway calls this on *every* request. **Fix:** atomic
   `onConflictDoUpdate` (works on both dialects); exclude `is_blocked` /
   `created_at` from the update set so a login never un-blocks a user or rewrites
   creation time.

## Reliability traps in the same diff

- **Graceful shutdown discarded `serve()`'s return** → no `server.close()`, so
  SIGTERM tore DB connections from in-flight requests. Capture the server, close
  it (drain), *then* flush audit + close DB.
- **`flush()` snapshotted `[...pending]` once** → writes enqueued mid-flush were
  dropped. Drain in a `while (pending.size > 0)` loop.
- **OIDC discovery cached the promise including on rejection** (`cached ??=`) →
  one transient network error broke login for the process lifetime. Cache only
  on success.
- **pg `Pool` had no `connectionTimeoutMillis`** → a saturated DB hangs handlers
  forever instead of failing fast.

## The reusable checklist (apply to any new auth/permission surface)

- [ ] Identity comes only from the server-side auth context, never client input.
- [ ] Every "trust" config list is validated entry-by-entry at boot.
- [ ] Convenience/default modes that weaken security have a prod boot guard.
- [ ] Layered trust paths are mutually exclusive, not a fallback chain.
- [ ] Read-modify-write on a uniquely-constrained table uses DB-atomic upsert.
- [ ] Secrets hashed at rest; tokens high-entropy; cookies HttpOnly/Secure/SameSite.
- [ ] Lifecycle events (`*_create`, `*_revoke`, `auth_denied`) hit the audit log.
- [ ] Test the **rejection** paths first (wrong aud/iss/exp/key, untrusted IP,
      state mismatch) — happy-path green says nothing about the gate.

## Calibrate to the trust model (don't over-engineer)

canvas-drop runs **inside a company**: everyone reaching it has passed org SSO,
and the email-domain allowlist keeps outsiders out (§12.0). The design principle
is **trusted colleagues, not hostile public internet**. This is a calibration,
not a loophole — apply it when planning AND when weighting review findings:

- **The hard invariants still hold absolutely** (the §12.0 list above —
  no impersonation, no cross-user/cross-canvas theft, no unauthorized access,
  lifecycle honored instantly). These survive the trust model because they're
  about colleagues *not being able to become each other*. A real bug here is
  still P0 (that's why the foundation review's P0/P1s were correctly weighted —
  they were all gateway/impersonation issues).
- **Beyond the invariants, stay proportionate and simple.** Light
  defense-in-depth for *accidents and resource safety* (a colleague's huge/
  pathological upload OOMing a small VPS; a typo'd config) is good. Elaborate
  *anti-malicious-insider* hardening (sandboxed extraction, nested-bomb ratio
  analysis, per-user anomaly detection, per-method permission matrices) is
  over-engineering against the product's own threat model — don't add it.
- **For reviewers:** deflate "hostile public internet" findings to match this
  model. Ask "does this break a §12.0 hard invariant, or is it an accident/
  resource concern?" — escalate the former, right-size the latter. A finding
  framed as "a malicious user could…" about a *non-invariant* surface is usually
  a P3 note here, not a P0.

The worked example: the deploy zip-bomb defense (stream + pre-inflate size cap,
one file buffered) is justified by **memory safety on a small host**, not by
"an insider crafts a bomb" — so it's in scope. Sandboxing the extractor would not be.

## Process lesson

Run `/ce-code-review` (multi-agent) **before** opening a PR on anything
auth/payment/migration-shaped. Self-review + green tests is necessary but not
sufficient — the adversarial + security personas construct failure scenarios
(omit-the-JWT, concurrent-first-login, /0-CIDR) that tests-as-written don't.
Cost ~10 parallel agents; cheap relative to shipping a P0. **Weight their
findings against the trust model above** — not every "an attacker could" is a P0
in a trusted-org product.

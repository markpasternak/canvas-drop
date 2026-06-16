---
title: OSS-packaging security review — the five invariants under the new Docker/compose surface
type: security
area: auth
date: 2026-06-16
---

The OSS launch-readiness round (Docker image + compose demo + CI secret-scan,
plan `2026-06-16-001`) added a new **attack surface** — a bundled identity stack —
without changing any application authorization code. This is the U8 review: scope,
what was checked, and the dispositions. Read alongside
[[2026-06-13-auth-invariant-checklist]] (the §12 failure modes) and the
trust-model calibration (trusted org, not hostile internet).

## Key fact: no app auth code changed

`git diff main...HEAD -- apps/ packages/` touches exactly two files —
`apps/server/src/docs/generated-content.ts` (a docs-build artifact) and
`packages/shared/src/config/env-example.test.ts` (a test). **Nothing under
`auth/`, `routing/`, `realtime/`, `deploy/`, or `canvas/` changed.** So the five
hard invariants' code is the same code reviewed in M7; this review is about
whether the new *packaging* surface weakens any of them.

## The five invariants

| # | Invariant | Status under this round |
|---|-----------|-------------------------|
| 1 | Identity from server-side context only | **Re-verified live.** The compose demo runs real `proxy`/JWKS mode; the app cryptographically verifies a Dex-signed JWT. A forged identity header / unsigned token resolves to **anonymous** (smoke test §4). |
| 2 | Authorization rungs, revoke/expiry honored live | Code unchanged; not reachable by packaging. Existing M7 coverage stands. |
| 3 | Canvas isolation (both URL modes, HTTP + WS) | Code unchanged. Demo runs `path` mode with the multi-user opt-in (its reduced-isolation caveat is the documented §12.2 tradeoff). |
| 4 | Secrets server-side only, hashed | Code unchanged. Demo ships no AI key; session/IdP secrets come from env; no secret reaches the browser. |
| 5 | Upload safety (zip-slip) | Code unchanged. Deploy pipeline untouched. |

## New-surface findings & dispositions

1. **JWKS cryptographic trust path — PASS (live).** oauth2-proxy forwards a
   Dex-signed JWT; the app verifies it against Dex's JWKS with matching
   issuer/audience. Chosen over the trusted-header path precisely so trust does
   not depend on pinning Docker's dynamic bridge IPs. Verified: real login →
   `/api/me` resolves the demo user; forged token → anonymous.
2. **App not host-exposed — PASS (live).** The `app` service publishes no port;
   only Caddy is reachable. Smoke test asserts the absence of a host port mapping.
3. **Edge header stripping — PASS.** `docker/Caddyfile` deletes client-supplied
   `X-Forwarded-Access-Token` / `X-Auth-Request-*` / `Authorization` before they
   reach oauth2-proxy. Belt-and-suspenders on top of the cryptographic check.
4. **Committed demo secrets — PASS.** `docker/` secrets are clearly-labeled
   DEMO-ONLY placeholders, suppressed by a **value-scoped** gitleaks allowlist
   (not path/rule-wide). A CI self-test plants a fake PAT outside the demo paths
   and asserts detection — proving the allowlist did not defang the scanner.
5. **Demo-promoted-to-prod risk — MITIGATED, residual accepted.** Someone could
   point a domain at the demo with secrets unrotated. Mitigations: `NODE_ENV=production`
   is set; every demo secret is labeled DEMO-ONLY; `cookie_secure=false` is
   documented as demo-only; `deploy.md` ships a graduation checklist. Residual
   misuse is proportionate to a trusted-org demo; not blocking.
6. **Runtime image ships devDependencies — FOLLOW-UP (not an invariant).** U1 copies
   the whole built workspace for a correct first image, so dev deps ride along
   (larger surface + size). Tracked follow-up: trim via `pnpm deploy --prod`. No
   auth/secret impact.

## Conclusion

No real finding against the five invariants; the new surface **upholds** them, and
§12.5 was empirically re-verified in real proxy/JWKS mode. The committed
`scripts/compose-smoke.sh` is the live regression artifact for the exposure +
forged-credential + persistence checks. The adversarial diff pass runs via
`/ce-code-review` before the PR (the plan's "/security-audit *and/or*
ce-code-review"); calibrated to the trust model, a whole-app re-audit of unchanged
M7 code would be disproportionate for a packaging change.

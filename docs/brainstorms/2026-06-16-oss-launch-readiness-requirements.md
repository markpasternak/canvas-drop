# OSS Launch Readiness — Requirements

**Date:** 2026-06-16
**Status:** Ready for planning (`/ce-plan`)
**Scope:** Standard — the OSS-packaging + safety slice of milestone **M10** (BUILD_BRIEF §16, §8.3)
**Brief:** Make canvas-drop publishable as an open-source project — a **"quiet credible drop."**

---

## Problem & context

canvas-drop is v1 feature-complete and merged to `main`. The one open milestone is **M10
(deployment + ops hardening + OSS packaging)**. The owner wants to take the repo public as MIT:
not a promoted Show-HN moment, but a **quiet credible drop** — the repo is public, discoverable,
and looks professional to anyone who finds it, with the safety and packaging needed to self-host
and trust it. Active promotion (demo push, contributor recruiting) comes later.

A repo scan establishes the real starting point:

**Already in good shape (do not rebuild):**
- `LICENSE` (MIT), `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`
- Dual-dialect CI matrix (`.github/workflows/ci.yml`) — lint, typecheck, test-sqlite, test-postgres, build
- Strong `README.md` (quickstart, publishing, primitives) and real self-hosting docs:
  `docs/site/self-hosting/{deploy,configuration,security-model,install}.md`
- Secrets hygiene: `.gitignore` excludes `.env*`, `/deploy/`, `*.pem`, ssh keys —
  **and git history is verified clean** (169 commits; no `.env`/key/secret blob ever committed;
  the only `deploy/` matches are app source under `apps/server/src/deploy/`, not infra)
- `.env.example` is already pedagogical (134 lines, grouped, every variable explained) — but it
  **defaults to dev** (`dev` auth · SQLite · path mode) and has no equally-teaching production example

**Missing for launch:**
- `Dockerfile`, `.dockerignore`, `docker-compose.yml` (BUILD_BRIEF §8.3 specifies these precisely)
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, third-party `NOTICE`/license inventory
- Automated secret-scanning + dependency-audit CI gate
- A focused §12 five-invariant security review (the auth-critical code is about to go public)

---

## Goals / outcomes

1. **Someone can self-host from the public repo in minutes** via `docker compose up`, following
   docs that teach the production profile, not just dev.
2. **The repo reads as professional and safe** to a stranger evaluating it — license, conduct,
   vuln-disclosure, and clean dependency/secret posture are all present.
3. **The repo stays clean** — secret and known-vuln leaks are blocked by CI, not vigilance.
4. **The five security invariants are confirmed to hold** before auth-critical code is public.
5. **The Docker setup is verified working**, not just authored — the stack boots and serves a canvas.

## Non-goals (deferred, not dropped)

- Single-VPS load test (150 users / 50 req/s + realtime broadcast) — follow-up.
- Backup/restore drill (scripts exist; proving round-trip) — follow-up.
- Promotion machinery: public demo push, Show-HN, contributor onboarding depth.
- Publishing a prebuilt image to GHCR (release machinery; leans "promoted") — see open questions.
- Third-party penetration test — §16 calls for a focused **internal** review, not a paid pen-test.

---

## Requirements

### R1 — Docker packaging (BUILD_BRIEF §8.3)
- **`Dockerfile`** — one multi-stage image for *our application only*: build the workspace
  (sdk → dashboard → server) and ship a slim, **non-root**, distroless-ish runtime. Dependencies
  (Postgres, proxy, MinIO) are **not** baked in.
- **`.dockerignore`** — keep `node_modules`, `data/`, `.env*`, build caches, agent-local state out
  of the build context.
- **`docker-compose.yml`** — `canvas-drop` (app) + a TLS-terminating reverse-proxy/IAP + `postgres`
  (with a volume), plus an **optional `minio` profile** for S3 testing. Defaults to the blessed
  production profile: subdomain mode · proxy-JWT auth · Postgres · S3-compatible storage.
- A canvas served by the app must work end-to-end in the composed stack (deploy → live URL).

### R2 — Pedagogical configuration for self-hosters
- Add a **production-profile env example** (teaching `subdomain` · `proxy`-JWT · `postgres` · `s3`),
  matching the existing `.env.example`'s commented, grouped, "explain every knob" style — so a
  self-hoster understands *why* each value is set, not just *what* to paste.
- The compose file's env wiring must be self-documenting (inline comments on the load-bearing vars:
  session secret, base URL, trusted-proxy/JWT settings, DB/S3 credentials).
- Keep `config` as the single `process.env` reader — the example teaches the surface, it does not
  add new env paths.

### R3 — Repo safety / legal files
- **`SECURITY.md`** — private vulnerability-disclosure policy (how to report, what's in scope,
  response expectations). References the five invariants as the security-critical surface.
- **`CODE_OF_CONDUCT.md`** — a standard contributor covenant (cheap professional signal).
- **Third-party `NOTICE` / license inventory** — confirm all bundled dependencies are
  MIT-compatible and attribute as required.

### R4 — CI hardening (extend `.github/workflows/ci.yml` or add a job)
- **Secret-scanning gate** (gitleaks-class) — fails the build on a committed secret; also run over
  history once to confirm the clean-history finding holds under tooling.
- **Dependency audit** (`pnpm audit`) — surfaces known-vuln dependencies at merge. **Advisory, not
  blocking** (decided during planning): the sole current finding is a dev-only transitive
  (`esbuild` via `drizzle-kit`, a Deno-specific advisory not affecting our Node usage), so hard-gating
  would break the build on an unfixable false-positive. See plan KTD4.
- The secret-scan runs in the existing matrix and blocks merge; dependency-audit runs advisory. No
  local-only hooks.

### R5 — README + repo polish
- Add a **"Self-host with Docker (~5 min)"** section driving `docker compose up`, linking to the
  production env example and `docs/site/self-hosting/deploy.md`.
- Verify all badges and links resolve; confirm the CI badge points at the real workflow.
- **Org-agnostic sweep** — confirm no organization-specific naming, branding, or internal
  references leaked anywhere public-facing (README, docs, examples, compose). (BUILD_BRIEF: MIT,
  org-agnostic, no telemetry/phone-home.)

### R6 — Five-invariant security review (BUILD_BRIEF §12.0, §16)
- A focused **internal** review of the five invariants, run via the existing `security-audit`
  skill / `ce-code-review` tooling. Review focus (§16): auth-gateway bypass; realtime handshake
  taking the same authorization path as HTTP; share revoke/expiry honored live; cross-canvas access
  (both URL modes, **HTTP and WebSocket**); key handling; the upload pipeline (zip-slip); SSRF
  (none should exist — the server makes no user-directed fetches); and audit usefulness.
- **Fix real findings**, weighted to the trust model: §12.0 hard-invariant bugs are P0; right-size
  hostile-internet findings on non-invariant surfaces (see
  `docs/solutions/2026-06-13-auth-invariant-checklist.md`). Add regression tests for real fixes.

### R7 — Starter examples
- Include **two lightweight example canvases** in-repo (e.g. a static one and one exercising a
  primitive) so an evaluator sees what a canvas *is* and what the SDK does. Keep them minimal.

### R8 — Verify the Docker setup (explicit success gate)
- Actually **bring up the compose stack and confirm it works** — app healthy (`/healthz` → ok),
  reachable through the proxy, a canvas deploys and serves at its URL, Postgres persists across a
  restart. Authoring the files is not "done"; the booted, serving stack is.

---

## Success criteria

- [ ] `docker compose up` brings up a working instance; `/healthz` returns ok; a canvas deploys and
      serves at its URL; data survives a container restart. **(verified, R8)**
- [ ] A self-hoster has a commented production env example that teaches the prod profile. (R2)
- [ ] `SECURITY.md`, `CODE_OF_CONDUCT.md`, and a license `NOTICE` are present and accurate. (R3)
- [ ] CI **blocks** on a planted secret (secret-scan); dependency-audit runs **advisory** (R4, see KTD4). (R4)
- [ ] README has a Docker self-host path; all badges/links resolve; org-agnostic sweep clean. (R5)
- [ ] Five-invariant security review run; all real findings fixed with regression tests. (R6)
- [ ] Two minimal example canvases in-repo. (R7)

---

## Decisions & assumptions

- **Launch posture:** quiet credible drop — professional and safe if found, no promotion push.
- **Hardening this round:** security review **only**; load test and backup/restore drill deferred.
- **Image distribution:** ship `Dockerfile`/compose for self-builders; **defer** publishing a
  prebuilt image to GHCR (see open questions).
- **Security review mechanism:** internal, agent-run (`security-audit` / `ce-code-review`), not a
  third-party pen-test — matches §16.
- **Examples:** two, minimal (M10 lists three; two is enough for a quiet drop).
- **Workflow:** this is plan-driven — the owner's autonomous full-scope round applies (one branch /
  one PR, build through, `/ce-code-review` before PR, CI green gates the merge).

## Open questions (for planning)

1. **GHCR image?** Default is Dockerfile-only. If a `docker compose up` that pulls a prebuilt image
   (no local build) is wanted for self-hosters, planning should add a release workflow. *(Deferred
   by default.)*
2. **Reverse proxy in the shipped compose:** which concrete proxy is the reference — Caddy
   (simple TLS + auth) vs. an oauth2-proxy/Cloudflare-Access shape? `deploy.md` already documents
   the JWT/JWKS path; the compose example should pick one runnable default. *(Implementation
   choice — resolve in `/ce-plan`.)*
3. **Secret-scanning tool:** gitleaks vs. trufflehog vs. GitHub's native scanning — pick in planning
   based on CI fit. *(Implementation choice.)*

---

## Source references

- `BUILD_BRIEF.md` §8.3 (Docker packaging), §12.0 (five invariants), §16 (M10 milestone)
- `docs/site/self-hosting/{deploy,configuration,security-model}.md` (existing prod docs)
- `.env.example` (the pedagogical bar to match for the production example)
- `docs/solutions/2026-06-13-auth-invariant-checklist.md` (trust-model calibration for R6)
- `.github/workflows/ci.yml` (the matrix R4 extends)

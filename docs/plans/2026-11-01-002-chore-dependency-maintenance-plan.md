# Dependency maintenance after the UX merge

Date: 2026-11-01 · Issue: [#150](https://github.com/markpasternak/canvas-drop/issues/150)

Status: approved by Mark for separate autonomous implementation and green-CI merge. UX PR [#149](https://github.com/markpasternak/canvas-drop/pull/149) merged as `4b8fc645bc942e6e6a4805c21fb27e4187eb10c5` after all CI checks passed. The shared checkout was pulled clean and this worktree branches from that merge.

Branch: `feat/dependency-maintenance-2026-11`.

## Outcome and boundary

Patch the security advisories and update compatible stable packages, preserving the newly verified UX, public APIs, authorization model, static-first architecture, and dual-dialect behavior. This is one maintenance unit/branch/PR with grouped implementation steps, not an unrelated framework migration. No production deployment, host Node upgrade, database/schema migration, new UI framework, or paid external-provider test is included.

Use the durable `docs/solutions/2026-11-01-dependency-review.md` as the dated baseline: 59/73 direct package names outdated; audit 32 advisories (7 high, 19 moderate, 6 low). Recheck registry/advisories at implementation start because those numbers are not a future acceptance guarantee.

## Setup, ownership, and sequencing

1. Verify the UX PR is merged. Pull `main` in the shared checkout with `git pull --ff-only` after confirming it is clean. Create a fresh worktree/branch from that main, for example `feat/dependency-maintenance-2026-11` / `../canvas-drop-dependency-maintenance-2026-11`.
2. Copy the reviewed plan into a new `docs/plans/` file, create the separate tracking issue, and link the dependency audit. Do not reopen/expand UX issue #148.
3. One implementation owner controls every manifest, `pnpm-workspace.yaml`, and the single lockfile. Parallel agents can review release notes and proposed diffs, then independently inspect runtime/auth and UI/build integration. Never run competing installs or full test suites.
4. Capture baseline `pnpm outdated -r --format json` and `pnpm audit --json` into the new unit's evidence directory. Audit/outdated nonzero results are data, not a reason to discard the output. Use a local `.tmp`/ignored directory or `/tmp` for raw logs; retain the summary and advisory identifiers in the tracked closeout.
5. Apply all agreed manifest floors/overrides in one edit pass, resolve once, inspect resolution, then install once. Avoid unbounded `pnpm update --latest` and `pnpm audit --fix`.

## Target package groups

These are the stable versions verified on 1 November. Refresh only to a newer patch if a new advisory/release warrants it; do not silently enlarge the major-version scope. Preserve existing `^` versus exact-pin style. Update both copies where a package is shared.

### Root `package.json`

- `@biomejs/biome` **^2.6.4**, `drizzle-kit` **^0.31.11**, `esbuild` **^0.28.2**.
- `highlight.js` **11.12.0**, `marked` **18.1.2**, `sanitize-html` **2.18.1** (these are exact pins today).
- `playwright` **^1.64.1**, `vitest` **^4.1.12**.
- `mermaid` **11.17.2**, retaining the exact current-major pin.
- Remove `embla-carousel-autoplay` if `rg` confirms no live import after the UX merge. Retain `embla-carousel` 8.6.0 for the manual carousel.
- Biome schema URL in `biome.json` must match **2.6.4**. Apply its necessary migration narrowly; do not run wholesale stylistic rewrites without inspecting the diff.

### Server dependencies

| Package | Target |
| --- | --- |
| @ai-sdk/anthropic | ^4.0.94 |
| @aws-sdk/client-s3 | ^3.1161.0 |
| @hono/mcp | ^0.3.5 |
| @modelcontextprotocol/sdk | ^1.32.2 |
| @node-rs/argon2 | ^2.2.2 |
| @opentelemetry/api | ^1.10.0 |
| ai | ^7.0.159 |
| drizzle-orm | ^0.45.4 |
| hono | ^4.13.14 |
| jose | ^6.2.14 |
| nodemailer | ^10.3.1 |
| openid-client | ^6.8.8 |
| pg | ^8.23.1 |
| pino | ^10.4.0 |
| pino-pretty | ^13.2.0 |
| playwright | ^1.64.1 |
| uuid | ^14.0.3 |
| zod | ^4.6.7 |

Server development dependencies: `@electric-sql/pglite` **^0.5.13**, `@types/pg` **^8.23.1**, `@types/ws` **^8.18.2**, `tsx` **^4.23.15**, `ws` **^8.22.0**. Preserve current better-sqlite3 12, its existing types, and @types/node for this bounded round. A schema change is neither needed nor acceptable as a dependency-update shortcut.

### Dashboard dependencies

| Package | Target |
| --- | --- |
| @codemirror/commands | ^6.11.1 |
| @codemirror/lang-html | ^6.4.12 |
| @codemirror/lang-markdown | ^6.5.2 |
| @codemirror/language | ^6.13.1 |
| @codemirror/state | ^6.7.6 |
| @codemirror/view | ^6.43.15 |
| @lezer/highlight | ^1.2.5 |
| @tanstack/react-query | ^5.105.0 |
| @tanstack/react-router | ^1.170.46 |
| react / react-dom | ^19.3.1 each |

Dashboard development dependencies: `@tailwindcss/vite` and `tailwindcss` **^4.3.3**; `@testing-library/react` **^16.3.3**; `@testing-library/user-event` **^14.6.8**; `@types/react` / `@types/react-dom` **^19.3.0**; `@vitejs/plugin-react` **^6.1.2**; `vite` **^8.3.5**; `vitest` **^4.1.12**. Retain jsdom 29.1.1 and jest-dom 6.9.1; patch their affected transitives within the current major.

### Shared and SDK packages

- `packages/shared`: `drizzle-orm` **^0.45.4**, `zod` **^4.6.7**.
- `packages/sdk`: `esbuild` **^0.28.2**.
- TypeScript **7.0.2**, Sharp **0.35.5**, direct Hono node-server **2.1.5**, fflate **0.8.3**, and other packages already current need no bump for its own sake.

### Conditional font updates

Fontsource Geist, Geist Mono, Newsreader latest is 5.3.0. Do not include automatically: `apps/server/src/http/brand-assets.ts` serves fixed `/fonts/*.woff2` URLs with `immutable` one-year cache. If the served font bytes are unchanged, a packaging-only update is reasonable after verifying exported file paths. If bytes change, retain the UX-verified versions and document the follow-up requirement for cache versioning and typography/screenshots. Do not introduce new font content behind the same immutable URL.

### Package-manager pin

A same-major pnpm maintenance bump to **11.28.9** is reasonable, with no pnpm 12 migration. If included, update these together:

- root `package.json` `packageManager`;
- `Dockerfile` corepack prepare version;
- `.github/workflows/ci.yml` `PNPM_VERSION`;
- the explicit versions in `docs/site/quickstart.md` and `docs/site/self-hosting/install.md` (and rebuild generated docs).

Use `pnpm ...` in the new worktree and verify `pnpm --version` reports the declared 11.28.9; the local pnpm shim selects it automatically. Do not globally upgrade the user's pnpm/Node installations. The host has a mise-managed pnpm 12 executable: running through Corepack exports an invocation marker that prevents this nested executable from switching to the project version, so nested package scripts fail with `ERR_PNPM_BAD_PM_VERSION`. Direct pnpm invocation preserves the strict version check and succeeds. CI installs the pinned pnpm using action-setup; Docker activates that same version via Corepack and has no competing mise binary. If version 11.28.9 produces unexpected lockfile-format or build-approval changes, keep 11.0.9 for this PR and record the toolchain migration separately rather than changing security posture to make installation pass.

## Transitive resolution and overrides

Raise the existing bounded overrides:

```yaml
"undici@>=7.0.0 <7.30.1": "^7.30.1"
"fast-uri@>=3.0.0 <3.1.9": "^3.1.9"
```

If ordinary resolution still leaves affected copies, add bounded same-major overrides:

```yaml
"body-parser@>=2.0.0 <2.4.0": "^2.4.0"
"seroval@>=1.0.0 <1.6.11": "^1.6.11"
```

Preserve unrelated existing overrides and `allowBuilds`; do not disable native build approval. The current MCP SDK 1.32.2 supports `@hono/node-server ^1.19.9 || ^2.0.5`, so first resolve it naturally to the already-supported **2.1.5**. If the lockfile retains vulnerable 1.19.17, a narrowly parent-scoped override is permissible only after confirming the installed SDK range:

```yaml
"@modelcontextprotocol/sdk@>=1.32.2 <2>@hono/node-server": "^2.1.5"
```

This is a deliberate selection of an upstream-supported alternative, not a global forced 1→2 override. Keep comments explaining the new advisory and inspect all copies with `pnpm why -r @hono/node-server`.

Do **not** add a deepmerge 4.3.2 override: that version was not published (registry 404), despite the audit JSON suggesting it. sanitize-html 2.18.1 removes deepmerge in favor of launder. Verify no other retained parent supplies it.

## Exact installation, regeneration, and inspection sequence

Run from the fresh maintenance worktree after the manifest edits above. The commands are a future execution recipe, not actions already performed.

```sh
pnpm --version
pnpm install --lockfile-only --no-frozen-lockfile
pnpm audit --json > /tmp/canvas-dependency-after-resolution.json
pnpm why -r zod nodemailer undici fast-uri body-parser seroval @hono/node-server deepmerge katex
```

Inspect the lockfile diff, advisory output, dependency origins, engines, peer-resolution warnings, and native optional packages before continuing. Fix manifest/override inconsistencies, then resolve again only if the files changed. Once reviewed:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm docs:build
pnpm docs:mermaid
pnpm landing:carousel
pnpm build
```

Required tracked generated output:

- `apps/server/src/docs/generated-content.ts` (marked, sanitize-html, highlight.js and any pnpm documentation change);
- `docs/site/assets/mermaid.js` (Mermaid/transitives/esbuild);
- `docs/site/assets/landing-carousel.js` (esbuild, with the existing content-hashed serving URL).

SDK and dashboard build output should remain ignored. Do not regenerate screenshots, brand imagery, or the tour animation merely because dependencies moved. Compare the real UI first; retake only if a verified rendering change affects the product images. Do not accidentally resurrect older copy via an unrelated brand-assets script.

## Targeted regression checks

Use `pnpm test:file` via the supervised runner. **Never mix dashboard and server paths in one invocation**: its routing selects one suite and can ignore the others. No parallel full suites. Read `docs/solutions/2026-06-13-ci-and-test-infra-gotchas.md` and the auth invariant checklist first.

Representative bounded checks (separate calls, sequential; omit redundant reruns once full gates pass):

```sh
pnpm test:file -- scripts/test-runner.test.mjs scripts/build-docs.test.mjs scripts/landing-carousel.test.mjs
pnpm test:file -- packages/shared/src/config/env.test.ts packages/shared/src/capabilities/index.test.ts apps/server/src/auth/proxy.test.ts apps/server/src/auth/oidc.test.ts apps/server/src/auth/session.test.ts
pnpm test:file -- apps/server/src/mcp/server.test.ts apps/server/src/mcp/provider.test.ts apps/server/src/mcp/routes.test.ts apps/server/src/email/smtp.test.ts apps/server/src/email/templates.test.ts apps/server/src/ai/provider.test.ts
pnpm test:file -- apps/server/src/db/db.test.ts apps/server/src/db/migrate-populated.test.ts apps/server/src/ops/backup.test.ts apps/server/src/storage/s3.test.ts
pnpm test:file -- apps/server/src/docs/render.test.ts apps/server/src/docs/integrity.test.ts apps/server/src/docs/routes.test.ts apps/server/src/http/landing-page.test.ts
pnpm test:file -- apps/dashboard/src/test/new.test.tsx apps/dashboard/src/test/create-recovery.test.tsx apps/dashboard/src/test/create-preview.test.tsx apps/dashboard/src/test/editor.test.tsx apps/dashboard/src/test/code-editor.test.tsx apps/dashboard/src/test/versions.test.tsx
pnpm test:file -- apps/dashboard/src/test/native-select.test.tsx apps/dashboard/src/test/people-email-combobox.test.tsx apps/dashboard/src/test/gallery.test.tsx apps/dashboard/src/test/filters.test.tsx
```

Confirm exact test paths exist after the UX merge before running; use the full suite instead of making up an alternate path. SMTP tests currently mock Nodemailer, so add/use a small **real package, no-network JSON-transport** smoke check for normal sender/recipient, envelope, and HTML/text behavior; do not send email. No live Anthropic, SMTP, OIDC, or S3 production calls. The existing AI/type and mocked service tests establish API compatibility; CI provides real isolated Postgres/S3-compatible coverage.

After Playwright installation, exercise the existing product capture integration (not an ad-hoc browser automation script):

```sh
CANVAS_DROP_TEST_SCREENSHOTS=1 CANVAS_DROP_TEST_MAX_WORKERS=1 pnpm test:file -- apps/server/src/screenshots/capture.integration.test.ts --testTimeout=90000 --hookTimeout=90000
```

The screenshot tests cover real Chromium rendition dimensions/top-of-page behavior, host resolution, and the network fence. Separately exercise the normal local screenshot worker with compact content plus a fixed-width canvas and verify output manually, preserving the UX round's 900×600/DPR2 and wide fallback behavior.

## Real browser acceptance

Use the available computer-use browser interface against an isolated local development fixture, with no production calls:

- Landing: hero typography, topic picker keyboard/typeahead/Escape, manual next/previous, reduced motion; no console errors.
- Dashboard at 390 and 1280 CSS px, light/dark: shared NativeSelect/FilterSelect caret/padding, keyboard focus outline, disabled state, open popup placement, and no document horizontal overflow.
- Editor: code input, selection/undo, language highlight, resize, draft preview, failed-save recovery, publish and version inspection. Preserve new recovery/fullscreen layering.
- Create: drag/drop, file picker, paste, ZIP validation, draft review, audience confirmation; existing dropzone major remains unchanged.
- Routing/query: filters/back/forward, gallery/library loading/error/empty, and unsaved-navigation guard.
- Docs: both existing Mermaid pages (`/docs/self-hosting/security-model` and `/docs/authoring/create-and-publish`) render in light/dark with theme changes, no blocked resource/CSP failure, and no console render errors. Inspect output after sanitize-html/marked changes.
- Server images: representative compact and fixed-width thumbnail captures; fonts load through their existing local routes.

## Major-version decisions for this PR

| Candidate | Decision and reason |
| --- | --- |
| Mermaid 12.2.0 | **Defer; use 11.17.2.** Upstream changes default layout to ELK and appearance to neo, raises browser syntax floor to ES2024/Safari17.4+, and adds roughly 500kB gzip to a single IIFE. Our custom base theme/es2020 IIFE deserves a dedicated renderer migration. That future work can choose `layout: dagre`, `look: classic`, retain the custom theme, and verify CSP/size/browser support. The low KaTeX advisory may remain explicitly documented. |
| Vitest 5.0.5 | **Defer; use patched 4.1.12.** Current mock security fixes are backported. v5 changes configuration/mocking/fake timers/deprecated entrypoints; no application benefit justifies broad test-infrastructure changes here. |
| jsdom 30.1.3 / jest-dom 7.0.1 | **Defer.** Keep existing test-DOM behavior while patching undici; inspect v30/v7 semantics in a test-tooling migration. |
| react-dropzone 20.1.4 | **Defer.** Three major releases touch a newly verified publishing path. No direct advisory in the baseline; keep 17.0.0 and record separately. |
| better-sqlite3 13.0.3 / @types/better-sqlite3 9.6.0 | **Defer.** 13 changes native packaging to N-API/prebuilt distribution. Useful future work, but requires fresh-container install, populated DB migration/backup/restore and native driver verification, not just typecheck. Keep 12.11.1 now. |
| pnpm 12 / @types/node 26 | **Defer.** Retain pnpm major11/Node24 deployment contract. The installed Node runtime is not part of this repository PR. |

Primary evidence: [Mermaid12 release](https://github.com/mermaid-js/mermaid/releases/tag/mermaid@12.0.0), [Vitest4.1.12 backport](https://github.com/vitest-dev/vitest/releases/tag/v4.1.12), [Vitest5 migration](https://vitest.dev/guide/migration/), [better-sqlite3 N-API release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0), [deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), and the full linked audit report.

## Completion gates and expected advisory outcome

- Full local `lint`, `typecheck`, dual-dialect plus dashboard `test`, build, and generated parity must pass on the final diff. Prefer the standard worker budget when the machine is free; use the documented one-worker invocation under contention, without committing timeout relaxations:

```sh
pnpm lint
pnpm typecheck
CANVAS_DROP_TEST_MAX_WORKERS=1 pnpm test --testTimeout=90000 --hookTimeout=90000
pnpm build
pnpm audit --json > /tmp/canvas-dependency-final-audit.json
pnpm outdated -r --format json > /tmp/canvas-dependency-final-outdated.json
```

- Re-run generators once after staging their intended outputs and check **unstaged** diff is empty for generated-content.ts, mermaid.js and landing-carousel.js. CI must also regenerate docs/Mermaid without drift. A resolved lockfile alone cannot prove served bundles are patched.
- Target **zero high/moderate advisories**, with at most the known **one low KaTeX** advisory deliberately retained under Mermaid11. This is an expectation to verify, not a preclaimed result. If another alert remains, inspect the actual tree/reachability and fix within scope or document an explicit evidence-backed exception; never silence the audit globally or promise a clean result before measuring.
- Independent multi-agent code review: one agent reviews runtime/auth/MCP/DB dependency and override changes; another reviews UI/test/build/browser compatibility and generated artifacts. Fix all real high-value findings and run affected regression checks. Root resolves shared-lockfile changes.
- Commit the maintenance unit, push, open its own PR, wait for required CI including real Postgres/S3-compatible coverage and secret scan, fix failures, squash merge/delete branch. Update the separate issue/plan/status and record actual package/advisory counts and deferred majors. Do not claim production deployment.

## Practical efficiency

Parallelize release-note review, source review, and documentation. Serialize manifests → resolution/install → generated builds → tests. Run targeted tests for fast feedback only where the changed package introduces risk; one complete final suite remains mandatory. Keep all major migrations deferred unless new evidence makes a specific one necessary, and do not let dependency work delay or mutate the already approved UX merge.

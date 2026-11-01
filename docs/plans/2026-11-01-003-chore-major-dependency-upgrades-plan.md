# Deferred major dependency upgrades

Date: 2026-11-01 · Issue: [#152](https://github.com/markpasternak/canvas-drop/issues/152)

Status: authorized by Mark as a separate autonomous PR after maintenance PR #151. One maintenance unit with sequential implementation phases and parallel research/review. Branch `feat/major-upgrades-2026-11`, based on `e3c7959` in an isolated worktree. Merge only after local gates, independent reviews and all required CI pass. Mark subsequently explicitly authorized upgrading Node on his Mac and the droplet. Include that runtime rollout after the PR is green, with a production backup, prior-runtime rollback path and verified service health; preserve unrelated workstation changes.

## Scope and compatibility contract

Update the previously deferred stable major lines, verified against npm registry metadata and upstream release/migration notes on 1 November:

| Dependency | Before | Target |
| --- | --- | --- |
| better-sqlite3 | 12.11.1 | 13.0.3 |
| @types/better-sqlite3 | 7.6.13 | 9.6.0 |
| pnpm | 11.28.9 | 12.16.1 |
| Vitest (root and dashboard) | 4.1.12 | 5.0.5 |
| jsdom | 29.1.1 | 30.1.3 |
| @testing-library/jest-dom | 6.9.1 | 7.0.1 |
| react-dropzone | 17.0.0 | 20.1.4 |
| Mermaid | 11.17.2 | 12.2.0 |

Use the verified current LTS Node **26.13.0 (Lithium)** for CI, containers, the Mac mise default and the droplet. Pin `.nvmrc`, use engine range `^26.13.0`, and update Node types to **26.6.6**. Node 26 does not bundle Corepack, so bootstrap the pinned pnpm explicitly. Retain the existing runtime until compatibility checks and a rollback path are ready. Add explicit required peers: Vite 8.3.5 at the root for Vitest 5, and Testing Library DOM 10.x in the dashboard for jest-dom 7. Preserve native build approvals and bounded advisory overrides; inspect whether newly obsolete entries/comments can be removed safely.

Geist Mono 5.2.8 remains a deliberate separate font/cache migration: it is not a major upgrade, and its 5.3.0 bytes cannot silently replace an immutable font URL. Do not recapture the product screenshots unless an actual rendering difference requires it.

## Execution phases

1. **Research and plan.** Three independent readers inspect runtime/native/package-manager, test-tooling, and UI/diagram changes. Root owns every manifest and the lockfile; no competing installs or full suites. Read the auth checklist, dual-dialect seam and test-infrastructure learnings. Record exact upstream links and decisions in the implementation evidence.
2. **Resolve and install.** Update coordinated manifests and pnpm pins in Docker, CI and current setup docs. Use project-selected pnpm 12.16.1; inspect engines/peers/native packages, then install the frozen lockfile. No schema change or migration is expected. Preserve the deployment's non-root user and platform interfaces.
3. **Adapt behavior.** Correct SQLite packaging docs (v13 includes N-API prebuilds and no install script). Preserve existing file/paste semantics explicitly with dropzone `noPaste: true` where applicable. Migrate actual Vitest/jsdom/jest-dom incompatibilities without weakening assertions, test coverage, worker supervision or timeout policies. Retain Mermaid strict security, local-only serving, token-based themes, dagre layout and classic appearance; validate browser/runtime requirements and measured bundle size. Rebuild the served bundles.
4. **Verify native and browser compatibility.** Exercise existing populated-migration and backup/restore coverage on both dialects. Add a fresh Linux image smoke check that exercises the actual compiled runtime/native driver, opening a database populated by the prior supported SQLite driver, migration idempotence/data preservation and backup/restore. Run this in CI; do not start the intentionally stopped host container services. Check the local macOS ARM64 driver as part of the normal suite.
5. **Independent review and release.** Review runtime/native/CI and UI/test/rendering separately, resolve all real findings and run affected checks. Full final lint, typecheck, root dual-dialect suite, dashboard suite, build, generated parity and audit. Push one PR, wait for all CI including the added container check and real Postgres/S3-compatible tests, squash merge/delete branch, close the issue and update the status/evidence.

## Browser acceptance

- Both Mermaid pages render in light and dark at desktop and phone widths, with existing local CSP, no console/render errors or overflow. Explicitly preserve `layout: dagre` and `look: classic`; esbuild syntax lowering is not a substitute for testing required runtime APIs. Avoid adding remote resources.
- Create from pasted HTML, file chooser and exported ZIP; inspect draft-first review and publish confirmation. File drag/drop and rejected inputs retain their meaningful regression coverage. Pasting normal text into an editor/form must not become a file upload.
- Editor input/undo, autosave/recovery, preview/fullscreen, version inspection, filters and navigation still work. Shared dropdowns, carousel and typography retain the freshly merged UX.
- Normal screenshot worker still captures compact and fixed-width layouts with the new native/runtime dependency graph.

## Gates and evidence

Use the supervised test runner, never mix dashboard/server paths in a targeted invocation, and run one full suite at a time. Invocation-only worker limits are permitted; repository assertions and timeout limits remain intact. Regenerate docs, Mermaid and carousel, stage intended output, regenerate again, and assert no unstaged drift. Audit the installed graph and report actual advisories rather than assuming the Mermaid major removes the retained KaTeX finding.

Record final package versions, peer/engine decisions, native-driver/container evidence, browser findings, test counts and any remaining intentional holds in `docs/solutions/2026-11-01-major-dependency-upgrades.md`. The tracking issue and linked PR are authoritative for final CI and merge state.

Primary references: [better-sqlite3 13 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0), [pnpm 12 release](https://github.com/pnpm/pnpm/releases/tag/v12.0.0), [Vitest migration guide](https://vitest.dev/guide/migration.html), [jsdom releases](https://github.com/jsdom/jsdom/releases), [jest-dom releases](https://github.com/testing-library/jest-dom/releases), [react-dropzone releases](https://github.com/react-dropzone/react-dropzone/releases), [Mermaid 12 release](https://github.com/mermaid-js/mermaid/releases/tag/mermaid@12.0.0). Registry manifests remain the version/engine/peer source of truth for the installed targets.

## Authorized Node rollout

Official source: [Node release index](https://nodejs.org/dist/index.json), verified Node26.13.0 is LTS Lithium released 28 October 2026. Mac Node24.22.1 is managed by mise with its config symlinked into `~/dotfiles`; update only the Node tool selection and preserve unrelated dirty files. The droplet uses the bare compiled server under systemd, not the repository Docker image. Inspect its installed NodeSource package, application revision and environment paths without printing secrets. Stage dependencies/build before stopping the service, take a consistent backup, retain the previous application/runtime for rollback, upgrade the actual service interpreter and package-manager path, start and verify public/authenticated boundary health and data preservation. Record actual outcomes privately without publishing server addresses or credentials in the open-source repository.

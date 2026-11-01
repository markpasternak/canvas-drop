---
title: Compatible dependency maintenance after the UX release
type: maintenance
area: dependencies
date: 2026-11-01
---

# Dependency maintenance — implementation evidence

Issue [#150](https://github.com/markpasternak/canvas-drop/issues/150), following the merged UX release [#149](https://github.com/markpasternak/canvas-drop/pull/149). The [approved plan](../plans/2026-11-01-002-chore-dependency-maintenance-plan.md) keeps this work in its own branch and PR. No production deployment or schema migration is included.

## Resolved outcome

Updated **52 distinct direct package names**, removed the unused Embla autoplay package, and synchronized pnpm **11.0.9 → 11.28.9** across the root manifest, Dockerfile, CI and setup docs. Native SQLite stays on 12.11.1; Node stays on the supported 24 line (local verification used **v24.22.1**). All lockfile resolution/install commands completed without changing build-script approvals or relaxing package-manager version checks.

The fresh baseline audit reproduced **32 advisories: 7 high, 19 moderate, 6 low**. After resolution and installation the audit reports **one low**, **zero moderate/high/critical**. The remaining [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) is KaTeX **0.16.47** under Mermaid **11.17.2**; its fixed line is **0.18.2+**. This is a dependency advisory result, not a claim about application exploitability or production deployment.

The final transitive graph resolves body-parser **2.4.0**, undici **7.30.1**, fast-uri **3.1.9**, and seroval **1.7.5**. The bounded overrides raised the vulnerable floors while leaving earlier unrelated majors alone. MCP SDK **1.32.2** permits Hono node-server **^1.19.9 || ^2.0.5**; the parent-scoped override selects **2.1.5**, removing the vulnerable 1.19.17 transitive copy without a global major override. sanitize-html **2.18.1** removes deepmerge entirely; no nonexistent deepmerge 4.3.2 override was added.

`pnpm outdated -r` now lists **nine** deliberately retained package names: Geist Mono, jest-dom, better-sqlite3 types, Node types, better-sqlite3, jsdom, Mermaid, react-dropzone and Vitest. Seven remain on their existing major/version line; Mermaid and Vitest received same-major updates but still have a newer major available. The initial missing-node_modules outdated query cannot supply installed-version counts; this comparison uses the UX workspace's resolved inventory retained in the earlier [dependency review](2026-11-01-dependency-review.md), then the newly installed maintenance tree.

## Compatibility decisions and gotchas

- **Font bytes, not package labels, control immutable-cache safety.** Compared the four served WOFF2 files from the UX installation against the 5.3.0 packages. Geist and both Newsreader files are byte-identical, so those two packages can update safely. Geist Mono changes bytes: both manifests now pin **5.2.8 exactly**. A future Mono update requires cache-versioned font URLs and visual verification.
- **Biome 2.6 broadens its language/rule surface.** The first lint run wanted to rewrite 213 historical Markdown files and flagged six test-local React fixtures plus a misleadingly named event handler. Explicitly disabled its newly available Markdown formatter/linter, preserving the previous code-focused scope; scoped only the new `noComponentHookFactories` rule off for dashboard test fixtures. Production keeps that rule; the event handler `useTheirVersion` became `adoptTheirVersion` with unchanged behavior. No broad source reformat was applied.
- **Corepack plus the host's mise pnpm can disagree in nested scripts.** `corepack pnpm` launches 11.28.9, but its exported marker makes the mise-managed pnpm 12 binary reached by nested scripts refuse automatic version selection. Direct `pnpm` and `pnpm exec pnpm --version` both report **11.28.9** and preserve strict version enforcement. Used direct pnpm for all final gates, with no global host edits. CI's action-setup installs 11.28.9 on PATH; Docker's Corepack activation prepares 11.28.9 inside the image, with no competing mise binary. These CI/container conclusions are source verification, not a claim that a container was executed locally.
- **One peer warning already existed:** `@hono/node-ws@1.3.1` has a 1.x node-server peer while the app directly uses 2.1.5 (installed package metadata: ^1.19.11; registry/lockfile peer metadata and pnpm diagnostic: ^1.19.15). The old UX lockfile already has that combination. No peer suppression or vulnerable downgrade was added. Realtime compatibility is covered by the normal runtime tests and the full suite.
- **Served bundles must be rebuilt.** Regenerated docs content and Mermaid after upgrading the Markdown/highlighting/sanitizing pipeline, Mermaid, and esbuild. Rebuilt the landing carousel; its bytes did not change. Mermaid's generated template literals contain upstream trailing spaces, so source whitespace checks exclude that generated asset; do not hand-edit it and break reproducibility.
- **Major migrations remain separate:** Mermaid12 changes default layout/appearance and browser syntax floor, Vitest5/jsdom30/jest-dom7 change test semantics, react-dropzone20 touches the freshly verified publishing flow, and better-sqlite3 13 changes native binary distribution. Retained the pnpm11/Node24 contract. See the plan's upstream links and future validation requirements.

## Installed direct-package changes

| Package | UX resolved version | Maintenance resolved version |
| --- | --- | --- |
| @ai-sdk/anthropic | 4.0.15 | 4.0.94 |
| @aws-sdk/client-s3 | 3.1087.0 | 3.1161.0 |
| @biomejs/biome | 2.5.4 | 2.6.4 |
| @codemirror/commands | 6.10.4 | 6.11.1 |
| @codemirror/lang-html | 6.4.11 | 6.4.12 |
| @codemirror/lang-markdown | 6.5.0 | 6.5.2 |
| @codemirror/language | 6.12.4 | 6.13.1 |
| @codemirror/state | 6.7.1 | 6.7.6 |
| @codemirror/view | 6.43.6 | 6.43.15 |
| @electric-sql/pglite | 0.5.4 | 0.5.13 |
| @fontsource-variable/geist | 5.2.9 | 5.3.0 |
| @fontsource-variable/newsreader | 5.2.10 | 5.3.0 |
| @hono/mcp | 0.3.2 | 0.3.5 |
| @lezer/highlight | 1.2.3 | 1.2.5 |
| @modelcontextprotocol/sdk | 1.32.1 | 1.32.2 |
| @node-rs/argon2 | 2.0.2 | 2.2.2 |
| @opentelemetry/api | 1.9.1 | 1.10.0 |
| @tailwindcss/vite | 4.3.2 | 4.3.3 |
| @tanstack/react-query | 5.101.2 | 5.105.0 |
| @tanstack/react-router | 1.170.44 | 1.170.46 |
| @testing-library/react | 16.3.2 | 16.3.3 |
| @testing-library/user-event | 14.6.1 | 14.6.8 |
| @types/pg | 8.20.0 | 8.23.1 |
| @types/react | 19.2.17 | 19.3.0 |
| @types/react-dom | 19.2.3 | 19.3.0 |
| @types/ws | 8.18.1 | 8.18.2 |
| @vitejs/plugin-react | 6.0.3 | 6.1.2 |
| ai | 7.0.29 | 7.0.159 |
| drizzle-kit | 0.31.10 | 0.31.11 |
| drizzle-orm | 0.45.2 | 0.45.4 |
| esbuild | 0.28.1 | 0.28.2 |
| highlight.js | 11.11.1 | 11.12.0 |
| hono | 4.13.13 | 4.13.14 |
| jose | 6.2.3 | 6.2.14 |
| marked | 18.0.6 | 18.1.2 |
| mermaid | 11.16.1 | 11.17.2 |
| nodemailer | 10.1.1 | 10.3.1 |
| openid-client | 6.8.4 | 6.8.8 |
| pg | 8.22.0 | 8.23.1 |
| pino | 10.3.1 | 10.4.0 |
| pino-pretty | 13.1.3 | 13.2.0 |
| playwright | 1.61.1 | 1.64.1 |
| react | 19.2.7 | 19.3.1 |
| react-dom | 19.2.7 | 19.3.1 |
| sanitize-html | 2.17.7 | 2.18.1 |
| tailwindcss | 4.3.2 | 4.3.3 |
| tsx | 4.23.1 | 4.23.15 |
| uuid | 14.0.1 | 14.0.3 |
| vite | 8.1.5 | 8.3.5 |
| vitest | 4.1.11 | 4.1.12 |
| ws | 8.21.1 | 8.22.0 |
| zod | 4.4.3 | 4.6.7 |

## Font comparison evidence

The old SHA is the served UX file; the candidate SHA is the 5.3.0 package file. The installed maintenance files are checked against the corresponding retained SHA.

| Served filename | Decision | UX SHA256 | Candidate 5.3.0 SHA256 |
| --- | --- | --- | --- |
| geist-latin-wght-normal.woff2 | Unchanged; package updated | `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1` | `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1` |
| geist-mono-latin-wght-normal.woff2 | Changed; package held at 5.2.8 | `af61b969e7f999969f6af576e584ee85dca301a008a76be1251d172d56b9904c` | `684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc` |
| newsreader-latin-wght-normal.woff2 | Unchanged; package updated | `62981321d9a3cc7a61a73792729043703fd6112da86e8ec848bb57f088578757` | `62981321d9a3cc7a61a73792729043703fd6112da86e8ec848bb57f088578757` |
| newsreader-latin-standard-italic.woff2 | Unchanged; package updated | `5dfcd10d24af8c82927ba57f7983dd997f7b200594c09c35a1b1ed9fc4597506` | `5dfcd10d24af8c82927ba57f7983dd997f7b200594c09c35a1b1ed9fc4597506` |

## Verification ledger

- Frozen-lockfile install: passed on pnpm11.28.9; the existing better-sqlite3/esbuild build approvals remain unchanged.
- Lint and typecheck: passed after the narrow Biome compatibility changes.
- All workspace production builds: passed; existing large-chunk advisory remains non-blocking.
- Targeted run: **29 tests across four files passed**, including six real-Chromium capture/network-fence checks, one real Nodemailer JSON-transport smoke test (no SMTP/network/email), 14 docs-generation tests and eight landing-carousel tests.
- Full supervised suite: **3,621 root tests passed across both SQLite and PostgreSQL/PGlite dialects** (194 passed files, two skipped files, nine skipped tests), followed by **880 dashboard tests passed across 91 files**. Used two workers and invocation-only 90s test/hook timeouts; no repository timeout relaxation. Root leg 113.58s; dashboard leg 77.34s.
- Generated-output reproducibility: passed after staging intended docs/Mermaid output and rerunning all three generators; no unstaged drift in generated-content.ts, mermaid.js or landing-carousel.js.
- Independent runtime/auth/MCP/DB source review: cleared; the reviewer independently confirmed font byte equality and preserved dependency identities. UI/build review, root browser checks, CI and merge remain release-owner verification.

Raw local evidence (temporary, useful for reruns): `/tmp/canvas-dependency-final-audit.json`, `/tmp/canvas-dependency-final-outdated.json`, `/tmp/canvas-dependency-installed.json`, `/tmp/canvas-dependency-font-comparison.json`, `/tmp/canvas-dependency-targeted.log`, `/tmp/canvas-dependency-full-test.log`, `/tmp/canvas-dependency-lint.log`, `/tmp/canvas-dependency-typecheck-final.log`, and `/tmp/canvas-dependency-build.log`. The durable tables and results above do not require those temporary files to survive.

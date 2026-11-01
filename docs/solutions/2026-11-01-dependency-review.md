---
title: Dependency currency review after the full-scope UX round
type: maintenance
area: dependencies
date: 2026-11-01
---

# Dependency review — 1 November 2026

Checked at **2026-11-01 06:51 UTC** in the integration worktree on **a4c1ae1**, with the UX changes still uncommitted. This is a read-only dependency inventory and advisory triage, not a completed upgrade or an application vulnerability assessment. No dependencies, manifests, lockfile, or application source were changed by this review.

The stack is modern, but **59 of 73 unique direct external package names** are behind the npm stable `latest` tag. Several updates cross major versions; “latest” is not automatically the appropriate maintenance target. TypeScript **7.0.2**, Sharp **0.35.5**, and the direct Hono node adapter **2.1.5** already match their registry latest versions.

## Evidence and runtime

- Host runtime: **Node v24.22.1**; package manager: **pnpm 11.0.9**, also pinned in the root manifest. CI uses Node 24 and both Docker stages use `node:24-slim`; this does not establish the currently deployed image's patch version.
- Read all five workspace manifests, the lockfile, workspace overrides, and CI/Docker configuration. Ran `pnpm outdated -r --format json` and `pnpm audit --json`, then checked npm registry metadata and upstream release/advisory pages.
- Raw session evidence: `/tmp/canvas-dependency-outdated-20261101.json` and `/tmp/canvas-dependency-audit-20261101.json`. These are temporary; the complete outdated-package table and all advisory identifiers are retained below so this report does not depend on those files surviving.
- Registry metadata is the source for version comparisons, for example [React latest](https://registry.npmjs.org/react/latest), [Zod latest](https://registry.npmjs.org/zod/latest), and [Vitest tags](https://registry.npmjs.org/vitest). Values are a dated snapshot and should be refreshed when implementing.

## Prioritized maintenance

1. **Security maintenance on existing major lines:** Zod **4.4.3 → 4.6.7**; Nodemailer **10.1.1 → 10.3.1** (10.1.7 is a narrower patch alternative); sanitize-html **2.17.7 → 2.18.1**; Vite **8.1.5 → 8.3.5** (minimum security patch 8.1.6); Vitest **4.1.11 → 4.1.12**. The [Vitest 4.1.12 release](https://github.com/vitest-dev/vitest/releases/tag/v4.1.12) explicitly backports its mock hardening, so a 5.x migration is unnecessary for that fix.
2. **Refresh vulnerable transitives and verify the resulting tree:** undici **7.30.0 → 7.30.1**, fast-uri **3.1.8 → 3.1.9**, body-parser **2.3.0 → 2.4.0**, and seroval **1.6.9 → ≥1.6.11**. Upgrade MCP SDK **1.32.1 → 1.32.2**, whose [manifest](https://registry.npmjs.org/@modelcontextprotocol%2Fsdk/1.32.2) permits the current Hono node adapter 2.x. Do not assume raising a parent package replaces every already-locked transitive copy. Preserve the repository's bounded-major override policy.
3. **Routine compatible upgrades:** React/React DOM **19.3.1**, Tailwind and its Vite plugin **4.3.3**, TanStack Query **5.105.0** / Router **1.170.46**, coordinated CodeMirror packages, and AI SDK/provider patches. Group related packages and run their existing regression suites. Font-package updates merit visual checks because they can change metrics.
4. **Separate migrations:** react-dropzone **17 → 20**, better-sqlite3 **12 → 13**, Mermaid **11 → 12**, jsdom **29 → 30**, Vitest **4 → 5**, and pnpm **11 → 12**. Keep these out of a narrowly scoped security patch. pnpm's stable latest was **12.16.1**, with **11.28.9** tagged for the current major. Do not follow a higher `next` tag by accident. Keep Node types aligned with the supported runtime rather than blindly selecting @types/node 26.

Playwright **1.61.1 → 1.64.1** also updates browser binaries. Check Docker installation, screenshot-worker execution, and visual output together. Any Mermaid update requires rebuilding and checking the committed `docs/site/assets/mermaid.js` bundle; see the existing [dependency-triage learning](2026-08-13-security-alert-triage-dependabot-and-codeql.md).

No additional UI library is needed to make the dropdowns consistent. The existing shared controls address that design problem. `embla-carousel-autoplay` appears unused after this branch's manual-carousel change and is a cleanup candidate; remove it only after checking the final merged source.

## Advisory result and interpretation

The audit reported **32 advisories: 7 high, 19 moderate, 6 low, 0 critical**. **13** appear in production dependency trees (**2 high, 8 moderate, 3 low**); **19** are development dependencies (**5 high, 11 moderate, 3 low**). “Production tree” is package-manager classification, not proof that the affected code path runs in this application. For example, Mermaid is delivered to the docs browser, while several MCP transitive packages are unused by our Hono transport.

- Zod validates live server/MCP inputs and deserves priority. Its [advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) lists a fix in 4.6.6; app-specific exploitability was not tested.
- The flagged Hono node adapter **1.19.17** is transitive under MCP. Our direct adapter is already **2.1.5**, and source search found no application `serveStatic` usage. Its [advisory](https://github.com/advisories/GHSA-rmxm-3fg6-px4f) is therefore not evidence of an application authentication bypass. Express/body-parser similarly arrive through MCP, with no direct Express app usage found.
- The audit payload suggests **deepmerge ≥4.3.2**, but that version returned **404** from npm and the [reviewed advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) says **no patched version**. Do not add an impossible override. [sanitize-html 2.18.1](https://registry.npmjs.org/sanitize-html/2.18.1) removes deepmerge in favor of launder, providing a viable parent-package update.
- KaTeX **0.16.47** is the previously retained low advisory. Mermaid **11.17.2** still requests KaTeX ^0.16.47; Mermaid **12.2.0** requests ^0.18.0, allowing the fixed **0.18.2+** line. Treat that as a renderer migration, with diagram regression checks, rather than forcing a cross-minor 0.x override.

| Affected installed package | Dependency classification | Advisory identifiers and upstream severity |
| --- | --- | --- |
| katex 0.16.47 | Production tree | [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) (low) |
| sanitize-html 2.17.7 | Development | [GHSA-x3q4-9hxx-gx8m](https://github.com/advisories/GHSA-x3q4-9hxx-gx8m) (moderate)<br>[GHSA-374f-7chj-9948](https://github.com/advisories/GHSA-374f-7chj-9948) (low)<br>[GHSA-cv27-6wvh-8x7j](https://github.com/advisories/GHSA-cv27-6wvh-8x7j) (moderate) |
| vite 8.1.5 | Development | [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv) (moderate)<br>[GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw) (moderate)<br>[GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) (high)<br>[GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw) (low)<br>[GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22) (moderate) |
| @vitest/mocker 4.1.11 | Development | [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) (moderate)<br>[GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp) (moderate) |
| zod 4.4.3 | Production tree | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (high) |
| body-parser 2.3.0 | Production tree | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) (high) |
| undici 7.30.0 | Development | [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) (moderate)<br>[GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) (moderate)<br>[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) (high)<br>[GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26) (high)<br>[GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) (high)<br>[GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) (high)<br>[GHSA-9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6) (moderate)<br>[GHSA-55wc-3pg8-jfw6](https://github.com/advisories/GHSA-55wc-3pg8-jfw6) (moderate) |
| nodemailer 10.1.1 | Production tree | [GHSA-8c8m-p3m8-cjg8](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8) (moderate)<br>[GHSA-m943-m63m-w62w](https://github.com/advisories/GHSA-m943-m63m-w62w) (moderate)<br>[GHSA-85x2-q946-cp5h](https://github.com/advisories/GHSA-85x2-q946-cp5h) (moderate) |
| fast-uri 3.1.8 | Production tree | [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg) (moderate)<br>[GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h) (low)<br>[GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr) (moderate)<br>[GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp) (low) |
| deepmerge 4.3.1 | Development | [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) (low) |
| seroval 1.6.9 | Production tree | [GHSA-f86p-h4j2-7qgj](https://github.com/advisories/GHSA-f86p-h4j2-7qgj) (moderate)<br>[GHSA-9wx9-5pv9-3349](https://github.com/advisories/GHSA-9wx9-5pv9-3349) (moderate) |
| @hono/node-server 1.19.17 | Production tree | [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f) (moderate) |

## Complete direct-package update inventory

These are installed/resolved versions, not just declared lower bounds. For example, Nodemailer's manifest starts at ^10.0.6, but the installed version is **10.1.1**. Latest versions come from the registry query at the time above. Shared workspace packages are excluded from the 73-package denominator.

| Package | Installed | Latest stable |
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
| @fontsource-variable/geist-mono | 5.2.8 | 5.3.0 |
| @fontsource-variable/newsreader | 5.2.10 | 5.3.0 |
| @hono/mcp | 0.3.2 | 0.3.5 |
| @lezer/highlight | 1.2.3 | 1.2.5 |
| @modelcontextprotocol/sdk | 1.32.1 | 1.32.2 |
| @node-rs/argon2 | 2.0.2 | 2.2.2 |
| @opentelemetry/api | 1.9.1 | 1.10.0 |
| @tailwindcss/vite | 4.3.2 | 4.3.3 |
| @tanstack/react-query | 5.101.2 | 5.105.0 |
| @tanstack/react-router | 1.170.44 | 1.170.46 |
| @testing-library/jest-dom | 6.9.1 | 7.0.1 |
| @testing-library/react | 16.3.2 | 16.3.3 |
| @testing-library/user-event | 14.6.1 | 14.6.8 |
| @types/better-sqlite3 | 7.6.13 | 9.6.0 |
| @types/node | 25.9.5 | 26.6.6 |
| @types/pg | 8.20.0 | 8.23.1 |
| @types/react | 19.2.17 | 19.3.0 |
| @types/react-dom | 19.2.3 | 19.3.0 |
| @types/ws | 8.18.1 | 8.18.2 |
| @vitejs/plugin-react | 6.0.3 | 6.1.2 |
| ai | 7.0.29 | 7.0.159 |
| better-sqlite3 | 12.11.1 | 13.0.3 |
| drizzle-kit | 0.31.10 | 0.31.11 |
| drizzle-orm | 0.45.2 | 0.45.4 |
| esbuild | 0.28.1 | 0.28.2 |
| highlight.js | 11.11.1 | 11.12.0 |
| hono | 4.13.13 | 4.13.14 |
| jose | 6.2.3 | 6.2.14 |
| jsdom | 29.1.1 | 30.1.3 |
| marked | 18.0.6 | 18.1.2 |
| mermaid | 11.16.1 | 12.2.0 |
| nodemailer | 10.1.1 | 10.3.1 |
| openid-client | 6.8.4 | 6.8.8 |
| pg | 8.22.0 | 8.23.1 |
| pino | 10.3.1 | 10.4.0 |
| pino-pretty | 13.1.3 | 13.2.0 |
| playwright | 1.61.1 | 1.64.1 |
| react | 19.2.7 | 19.3.1 |
| react-dom | 19.2.7 | 19.3.1 |
| react-dropzone | 17.0.0 | 20.1.4 |
| sanitize-html | 2.17.7 | 2.18.1 |
| tailwindcss | 4.3.2 | 4.3.3 |
| tsx | 4.23.1 | 4.23.15 |
| uuid | 14.0.1 | 14.0.3 |
| vite | 8.1.5 | 8.3.5 |
| vitest | 4.1.11 | 5.0.5 |
| ws | 8.21.1 | 8.22.0 |
| zod | 4.4.3 | 4.6.7 |

## Validation for a follow-up implementation

Use a dedicated maintenance unit/plan and review dependency and generated-asset diffs. Run lint, typecheck, both database dialects, dashboard tests, docs/bundle drift checks, and production build; verify affected SMTP, MCP/auth, editor, upload, and preview-worker flows. Re-run the advisory check after resolution, record remaining exceptions with reachability evidence, and merge only after required CI is green. This report does not claim those upgrades or validations have happened.

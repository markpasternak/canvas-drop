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

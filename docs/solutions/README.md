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

<!-- Thanks for contributing! Most PRs only need the section below.
     Working a plan unit? There's an optional internal-loop block at the bottom. -->

## What

<What does this change do, and why? Link the issue it addresses.>

## Checklist

- [ ] `pnpm lint` && `pnpm typecheck` clean
- [ ] `pnpm test` passes (runs **both** SQLite + Postgres dialects in-process)
- [ ] Behaviour changes have tests
- [ ] No `process.env` access outside `config/`; no secrets in client-facing code

<!-- ────────────────────────────────────────────────────────────────
Internal plan-driven loop only — delete this whole block for a normal PR.
A small external fix does NOT need a U<N> id or a plan (see CONTRIBUTING.md).

Title: U<N>: <what> (#<issue>)  ·  Closes part of #<issue> — U<N>
Branch: feat/u<N>-<slug>  ·  unit claimed on #<issue>
Learning captured? link to docs/solutions/... (or n/a)
──────────────────────────────────────────────────────────────── -->

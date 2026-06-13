<!-- Title: U<N>: <what> (#<issue>) -->

## What

<What this unit does. Link the plan unit and issue.>

Closes part of #<issue> — **U<N>**.

## Test scenarios implemented

<List the plan's test scenarios covered here. Feature-bearing units must have tests.>

- [ ] ...

## Checklist

- [ ] Tests pass on **both** dialects (`pnpm test:sqlite` && `pnpm test:pg`) where applicable
- [ ] `pnpm lint` && `pnpm typecheck` clean
- [ ] No `process.env` access outside `config/`
- [ ] No secrets in client-facing code
- [ ] **Learning captured?** yes (link to `docs/solutions/...`) / n/a

## Tracking

Branch `feat/u<N>-<slug>` · unit claimed on #<issue>

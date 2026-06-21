# Tenancy — the org boundary (Phase 1)

canvas-drop has a member-vs-guest boundary: brought-in **guests** (Gmail or any non-org
domain) cannot see canvases shared with the **whole org**. This page is the operator
runbook for turning it on and migrating existing data.

> Phase 1 scope: one org per instance, membership derived from the user's verified email
> domain. Teams (P2), multiple orgs on one instance (P3), and self-serve signup (P4) build
> on this. See `docs/plans/2026-06-20-002-feat-tenancy-p1-org-boundary-plan.md`.

## The model

- An **org** owns a set of **domains** (e.g. `acme.com`, `eng.acme.com`). A signed-in user
  whose verified email domain **exactly** matches one is a **member** of that org; everyone
  else who can sign in (allowlisted guests, admins on other domains) is a **guest**.
- Each canvas has a **home tenant** (`org_id`): `null` = personal, or an org id. A member
  picks Personal or their org when creating; a guest only ever gets Personal.
- The `whole_org` access rung means **"members of the canvas's home org"** — not "any
  signed-in user". A `whole_org` canvas with a null `org_id` is visible to **no one but the
  owner** (it's an explicit deny everywhere).
- Membership is always resolved **server-side** from the session/token identity. A client
  can never assert which org it belongs to.

## Inert until configured

Deploying the code changes **nothing** until you name an org. With no
`CANVAS_DROP_ORG_NAME`, tenancy is **inert**: `whole_org` keeps its legacy "any signed-in
user" meaning and `org_id` is ignored everywhere (serve, gallery, clone). This makes the
rollout safe — you merge first, migrate later.

## Configuration

| Var | Meaning |
|---|---|
| `CANVAS_DROP_ORG_NAME` | The org's display name. **Setting this turns tenancy on.** Unset = inert. |
| `CANVAS_DROP_ORG_DOMAINS` | Comma-separated member domains. Defaults to `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` (the common single-org case). |

Domains are normalized to lowercase ASCII; punycode IDNs before listing them. At boot the
instance materializes the org + its domains idempotently and **fails loud** on a bad config:
a domain mapped to two orgs, more than one org (multi-org is Phase 3), or an org with **no
domains** (a member boundary nobody can be inside — every `whole_org` canvas would become
invisible).

The configured domain set is **authoritative**: a domain you **remove** from
`CANVAS_DROP_ORG_DOMAINS` is pruned at the next boot, so its users correctly drop to guest.
Membership can be narrowed, not just widened — no stale domain keeps granting access.

## Rollout

1. **Merge** the code. It's inert — production is unchanged.
2. **Dry-run against a restored copy of production.** Set the org config on the copy and run:
   ```
   pnpm tenancy:plan
   ```
   This is **read-only**. Review the report: the member/guest split, any **admins reclassified
   as guests** (they're on a non-org domain), and the per-canvas access deltas — especially
   the guest-owned `whole_org` canvases that will be **clamped to private**.
3. **Configure + deploy.** Set `CANVAS_DROP_ORG_NAME` (and confirm `CANVAS_DROP_ORG_DOMAINS`)
   on production and deploy. The boot step materializes the org. `whole_org` is now
   members-only; guests keep only their `specific_people` grants.
4. **Run the backfill** on production:
   ```
   pnpm tenancy:plan --apply
   ```
   This is **idempotent + resume-safe**: it sets `org_id` by owner domain `WHERE org_id IS
   NULL`, clamps guest-owned `whole_org` → `private`, then **verifies** that nothing remains
   to change. Always run the plain dry-run before every apply.

## What the backfill does

- Member-owned canvases get `org_id` = the owner's org (any rung; only `whole_org` changes
  visibility — it becomes org-scoped).
- **Guest-owned `whole_org` canvases are clamped to `private`** (their `org_id` stays null).
  A null-org `whole_org` row is a latent footgun, so the cutover removes it.
- Everything else (private / specific_people / public_link, and guest-owned personal
  canvases) is untouched.

## Reversibility

Clearing the org config (unset `CANVAS_DROP_ORG_NAME`) returns the instance to inert —
`whole_org` is org-agnostic again. The backfilled `org_id` values remain on the rows but are
ignored while inert. (The clamp of guest-owned `whole_org` → private is a data change and is
not auto-reverted; a pre-apply DB snapshot is the way back if needed.)

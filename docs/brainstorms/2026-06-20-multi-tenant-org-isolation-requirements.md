# Multi-Tenant Org Isolation — Members, Guests, Teams (Requirements)

> Captures an interview (2026-06-20) on adding an **organization / team** model so brought-in
> outsiders (Gmail, other domains) can't see content shared "with the org." Phased: fix the
> isolation leak now, architect toward many isolated orgs on one instance.

- **Date:** 2026-06-20
- **Status:** Ready for planning (`/ce-plan`) — four phase plans drafted alongside this doc.
- **Branch / worktree:** `feat/multi-tenant-orgs`
- **Delivery:** four sequential, independently-shippable phases. Phase 1 is the user's stated
  need and the foundation; Phases 2–4 build on it and are re-planned at depth when their turn comes.
- **Invariant-critical:** this touches identity → tenant resolution and the canvas authorization
  table (§12). A mandatory multi-agent review (`/ce-code-review`, security + adversarial personas)
  gates **every** phase's PR — see `docs/solutions/2026-06-13-auth-invariant-checklist.md`.

## Outcome

canvas-drop assumes **one org per instance**: "who's in your org" = "anyone who clears the
sign-in gate" (allowed email domains + the admin allowlist). The moment you allowlist a Gmail
user or another domain to collaborate on *one* canvas, they join that single pool — so
`whole_org` sharing and the gallery leak to them. There is no **member-vs-outsider boundary**, no
**team** grouping, and no notion of **separate orgs** that can't see each other.

This work introduces a real boundary: a person is a **member** of an org (by verified email
domain) or a **guest** (an individual with only their own private space). "Share with my org"
means **org members only**, never guests or other domains. Teams add intra-org sharing groups.
An `org_id` threads through the data model so opening the instance to **many isolated orgs**
later (even internet-facing) is configuration and new routing, not a rewrite.

## Background — the current model (grounded in code)

- **Sign-in gate:** `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` (domains) + `allowed_emails` (individual
  addresses) + `CANVAS_DROP_ADMIN_EMAILS`. Identity is resolved **server-side** (proxy/oidc/dev);
  never from client input (§12.0).
- **Access ladder (already exists):** `canvases.access ∈ { private, specific_people, whole_org,
  public_link }`. Authorization is one default-deny table, `decideCanvasAccess`; owner-only
  editing is `requireOwnedCanvas`. Admins are **not** a bypass for others' canvases.
- **Guests already exist:** the access-ladder work admits non-org principals (invited guests via
  magic links, anonymous public visitors). Guest principals are namespaced (`guest:<inviteId>`)
  and scoped to their invited canvas.
- **The leak:** `whole_org` currently resolves to "any signed-in principal that passed the org
  gateway" — which now includes allowlisted Gmail/other-domain users. There is no per-org scoping
  on a canvas, and the gallery lists `whole_org`+`galleryListed` canvases to everyone signed in.

## Decisions locked (from the interview)

**Scope & horizon**
- **D1 — Phased.** Fix guest isolation now; thread `org_id` through from day one so multi-org is a
  later config/routing change, not a rewrite. No dead end.
- **D2 — Membership = verified email domain.** `@acme.com` signs in → Acme **member**.
  Gmail / other domains → **guests**: they only see canvases explicitly shared with them, never
  the org gallery or `whole_org` content.
- **D3 — Person owns; scopes widen.** Canvases stay **user-owned** (unchanged). The ladder widens
  *private → specific people → my team(s) → my whole org → public*. "Org" excludes guests **by
  definition**.

**Boundary mechanics**
- **D4 — Guests are self-sufficient individuals.** A guest can create + own their own
  *private / specific-people* canvases, but never sees any org or team scope.
- **D5 — Operator configures the domain → org map.** The instance operator declares "these domains
  = Org X." Near-term that's just your member domain(s) vs everyone-else-is-guest.
- **D6 — Teams are self-serve.** Any **member** creates a team and invites other members; an org
  owner can oversee. Members-only — guests are never on a team.
- **D7 — Soft scoping now, subdomain-per-org later.** One DB + storage with `org_id` on the rows
  that need it, enforced at the **service layer** (the same invariant as today's ownership
  checks). Going internet-facing later gives each org its own subdomain (`acme.host`) for
  browser-origin isolation; personal/guests stay on the main host.

**Onboarding, structure, governance, cutover**
- **D8 — Invite-only now, signup-ready later.** A member/admin invites a guest's email (today's
  allowlist) before they can sign in; the flow is built so flipping on open self-signup later is a
  config toggle.
- **D9 — Every user gets a personal space; org is additional.** A "Personal" workspace for
  everyone, plus members additionally belong to their org(s) — a workspace switcher
  (Personal / Acme). One uniform tenant model. (Implementation: *personal space = `org_id` null*;
  see R-model.)
- **D10 — Instance operator governs for now.** No per-org admin console yet; the operator is the
  only admin. Per-org governance arrives when a second org does (Phase 3/4).
- **D11 — Auto-scope at cutover.** On deploy, existing `whole_org` shares clamp to org-members-only
  and brought-in guests lose that access (the fix). `specific_people` grants and `private` are
  preserved. (A dry-run report precedes the live apply — see R12.)

## The model

- **Org** — an isolation boundary defined by **one or more verified email domains**, operator
  configured. Phase 1 ships exactly one (yours); the schema supports many.
- **Personal space** — every user's own workspace, modeled as **`canvas.org_id = NULL`**. First
  class in the UI (a workspace you switch into); needs no separate table.
- **User** — a person, by email. Always has a personal space. Is a **member** of an org iff their
  email domain ∈ that org's domains (else a **guest** = personal only). Phase 1 derives membership
  from domain at request time; explicit `org_members` rows arrive with Teams (Phase 2).
- **Team** — a members-only group **within** one org (Phase 2).
- **Canvas** — **owner = a user** (unchanged). **Home tenant = `org_id`** (an org the owner is a
  member of, or `NULL` = personal). The home tenant determines which scopes are even available.

### The scope ladder (resolved)

| Home tenant | Available `access` scopes |
|---|---|
| **Personal** (`org_id` null) | `private` → `specific_people` *(invite any email, incl. guests)* → `public_link` *(admin-gated)* |
| **Org** (`org_id` set) | `private` → `specific_people` → `team` *(Phase 2)* → `whole_org` *(org members only)* → `public_link` *(admin-gated)* |

- **`specific_people`** is the **only** cross-boundary path (invite an external/guest by email) —
  it already exists and is unchanged.
- **`team` / `whole_org`** never cross the org wall and never reach guests.
- **`public_link`** stays admin-gated (the one truly-open rung).
- **Gallery** becomes per-org: an org's gallery shows org-listed canvases to that org's members
  only. Personal/guests get no org gallery.

### Isolation invariant (the load-bearing rule)

The enforcement is an **extension of the existing single authorization table**, not a new parallel
guard (the §12 checklist explicitly warns against a second seam):

- Every canvas carries `org_id` (null = personal). Per-canvas children (kv, files, versions,
  drafts, …) inherit the org via their canvas — **only `canvases` needs the column** for Phase 1.
- The caller's **org membership set** is resolved **server-side** from their verified email domain
  (never client input), attached to the request principal.
- `decideCanvasAccess` changes one rung: **`whole_org` now requires the viewer's membership set to
  contain `canvas.org_id`** (and `team` requires team membership in Phase 2). A `whole_org` canvas
  whose `org_id` the viewer isn't a member of resolves as **not found** (the §12.0 rule). Personal
  (`org_id` null) canvases can never satisfy `whole_org`/`team`.
- The same service layer backs the HTTP routes **and** the 33 MCP tools, so **MCP inherits the
  scoping for free** (agent-native parity) — no parallel implementation.

## Requirements

Phase tags in brackets; plans trace these R-IDs.

- **R1 [P1] Org + domains model.** `orgs` + `org_domains` tables; operator configures the
  domain→org map (config-first; reuse `ALLOWED_EMAIL_DOMAINS` as the seed). Additive, dual-dialect
  migration; schema-parity test green.
- **R2 [P1] Canvas home tenant.** Additive nullable `canvases.org_id` FK (null = personal).
- **R3 [P1] Member/guest classification at login.** Resolve the caller's org membership set from
  verified email domain, server-side, on session resolve; attach to the principal. Guests = no
  match. **Rejection-path tested first.**
- **R4 [P1] Re-scope `whole_org`.** `decideCanvasAccess`: `whole_org` ⇒ viewer ∈ members of
  `canvas.org_id`; non-member → 404. Personal canvases never match. One table, no second seam.
- **R5 [P1] Org-scoped gallery + lists.** Gallery and any "org" listing filter to the viewer's
  org(s); personal/guests excluded from org galleries.
- **R6 [P1] Workspace surface.** Dashboard shows Personal vs the member org (a switcher);
  create-canvas picks the home tenant (members default to Org). `/api/me` returns the caller's
  orgs + role. Guests see only Personal.
- **R7 [P1] MCP parity.** Every owner-facing change (home-tenant choice, the re-scoped `whole_org`,
  org-filtered lists) is reachable over MCP, wrapping the same service layer with the same checks.
- **R8 [P1] Cutover migration (auto-scope).** Seed the member org from configured domains; set
  `org_id` on existing canvases by owner domain (members → org, guests → personal); existing
  `whole_org` becomes members-only automatically; `specific_people`/`private` preserved. Ships with
  a **dry-run report** (R12).
- **R9 [P2] Teams.** `org_members` + `teams` + `team_members`; self-serve team CRUD + invites
  (members only); the `team` access rung; team-scoped gallery filter; MCP + docs parity.
- **R10 [P3] Multi-org readiness.** Allow >1 org; operator provisions additional orgs;
  **subdomain-per-org** routing + browser-origin isolation; reconcile with the existing canvas URL
  mode; per-org quotas/limits.
- **R11 [P4] Public-facing.** Self-serve verified-domain org claim; open guest-signup toggle +
  abuse controls (rate limit, email verification); a per-org admin console + role model.
- **R12 [P1] Safe cutover tooling.** A `tenancy:plan` dry-run that reports, per user/canvas, the
  exact access deltas (who gains/loses what) before any write; the live migration is idempotent and
  additive/back-compatible (no destructive rewrite of live data).
- **R-sec [all] Invariant tests.** For every phase, test the **rejection** paths first: a
  guest/non-member hitting a `whole_org`/`team` canvas → 404; identity/membership only from
  server context; admins are not a cross-org bypass; guest principals stay scoped.

## Phasing

| Phase | Ships | Requirements | Solves |
|---|---|---|---|
| **1 — Org boundary + foundation** | orgs+domains, `canvases.org_id`, login classification, re-scoped `whole_org`, org-scoped gallery, workspace surface, MCP parity, auto-scope migration + dry-run | R1–R8, R12, R-sec | **Your stated pain — guests walled off from org content** |
| **2 — Teams** | `org_members`+`teams`+`team_members`, self-serve teams, the `team` rung, team gallery, MCP/docs | R9, R-sec | intra-org sharing groups |
| **3 — Multi-org ready** | >1 org, operator provisioning, subdomain-per-org + origin isolation, per-org quotas | R10, R-sec | host several isolated orgs on one instance |
| **4 — Open to internet** | self-serve domain claim, guest-signup toggle + abuse controls, per-org admin console | R11, R-sec | public SaaS |

## Open items (defaulted unless changed)

1. **Member default workspace** on create → **Org** (switcher to Personal).
2. **Existing private member canvases** at cutover → home = **Org** (scope still `private`).
3. **Quotas/limits per org** → deferred to Phase 3 (stay global/per-user until then).
4. **Vocabulary** → "Organization / Team / Personal" in product copy (model term: *tenant* = org |
   personal). Confirm before it's stamped across UI/API/MCP/docs.
5. **URL wrinkle (Phase 3):** the existing *canvas* URL mode (path vs subdomain) is a separate axis
   from org-subdomain; reconcile `acme.host/c/slug` vs `slug.acme.host` when Phase 3 is planned.

## Risks / watch-list

- **§12 regression surface.** Re-scoping `whole_org` is an authorization change on a live access
  path — the highest-risk edit in the project. Mitigation: one table (`decideCanvasAccess`), no
  second seam; rejection-first tests; mandatory security/adversarial review per phase.
- **Silent cutover exposure or removal.** Auto-scope changes who can see existing canvases.
  Mitigation: the R12 dry-run report is reviewed before the live apply; the migration is
  additive + idempotent.
- **Membership staleness (when explicit rows land in P2).** Removing a domain must reconcile
  derived memberships. Mitigation: keep P1 membership *derived* (always consistent with the domain
  map); introduce explicit rows + reconciliation deliberately in P2.
- **Proxy mode.** External rungs are disabled in proxy mode today; the guest path must stay
  *not mounted* (not merely inert) there — preserve that.
- **Scope creep into a full RBAC.** D10 keeps governance at the operator until Phase 3/4. Don't
  build a per-org role matrix before there's a second org.

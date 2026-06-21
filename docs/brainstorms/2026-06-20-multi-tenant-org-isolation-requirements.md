# Multi-Tenant Org Isolation — Members, Guests, Teams (Requirements)

> Captures an interview (2026-06-20) on adding an **organization / team** model so brought-in
> outsiders (Gmail, other domains) can't see content shared "with the org." Phased: fix the
> isolation leak now, architect toward many isolated orgs on one instance.
>
> **Revised 2026-06-20** after a 5-lens plan review (security / adversarial / architecture /
> feasibility / coherence). The review corrected the "single seam" framing (there are **three**
> enforcement seams), several file references, and a set of model edges (see "Review corrections").

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
sign-in gate" (allowed email domains + the `allowed_emails` allowlist). The moment you allowlist a
Gmail user or another domain to collaborate on *one* canvas, they join that single pool — so
`whole_org` sharing and the gallery leak to them. There is no **member-vs-outsider boundary**, no
**team** grouping, and no notion of **separate orgs** that can't see each other.

This work introduces a real boundary: a person is a **member** of an org (by verified email
domain) or a **guest** (an individual with only their own private space). "Share with my org"
means **org members only**, never guests or other domains. Teams add intra-org sharing groups.
An `org_id` threads through the data model so opening the instance to **many isolated orgs**
later (even internet-facing) is configuration and new routing, not a rewrite.

## Background — the current model (grounded in code)

- **Sign-in gate:** `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` (domains) + the `allowed_emails` table
  (individual addresses) + `CANVAS_DROP_ADMIN_EMAILS`. `isEmailAllowed` (`auth/identity-mapping.ts`)
  admits by domain **OR** the individual allowlist. Identity is resolved **server-side**
  (proxy/oidc/dev); never from client input (§12.0).
- **Access ladder (already exists):** `canvases.access ∈ { private, specific_people, whole_org,
  public_link }`, enforced by a DB `CHECK` constraint (`canvases_access_chk`, both dialects).
  The serve-path authorization is one default-deny table, `decideCanvasAccess`
  (`apps/server/src/canvas/authorization.ts:85`); owner-only editing is `requireOwnedCanvas`
  (`apps/server/src/canvas/owner-guard.ts` — a **different** seam). Admins are **not** a bypass for
  others' canvases.
- **Guests already exist:** the access-ladder work admits non-org principals (invited guests via
  magic links, anonymous public visitors), namespaced (`guest:<inviteId>`), scoped to their canvas.
- **The leak is on THREE paths, not one** (review correction):
  1. `decideCanvasAccess` — `whole_org` resolves to "any signed-in member that passed the gateway"
     (`authorization.ts:138` checks only `principal.kind === "member"`, no org).
  2. The gallery / owner-list SQL predicate `galleryVisibilityFilters`
     (`db/repositories/canvases.ts:264`) — a viewer-less `WHERE` that returns every
     `whole_org`+listed canvas; `listGallery` passes no principal.
  3. `findCloneableTemplate` (`canvases.ts:1245`) — reachable from the gallery route **and** MCP
     `clone_canvas`; a guest can clone an org `whole_org` template by id and exfiltrate its files.

## Decisions locked (from the interview)

**Scope & horizon**
- **D1 — Phased.** Fix guest isolation now; thread `org_id` through from day one so multi-org is a
  later config/routing change, not a rewrite. No dead end.
- **D2 — Membership = verified email domain, and ONLY that.** `@acme.com` signs in → Acme
  **member**. Everyone else — Gmail, other domains, **and individually `allowed_emails`-admitted
  addresses or `ADMIN_EMAILS` on a non-org domain** — is a **guest**: they only see canvases
  explicitly shared with them, never the org gallery or `whole_org` content. (This *supersedes* the
  current schema comment that says allowlisted addresses "sign in as org members": post-change they
  sign in as **guests**. The cutover dry-run flags every such reclassification — see R8.)
- **D3 — Person owns; scopes widen.** Canvases stay **user-owned** (unchanged). For an **org-home**
  canvas the ladder widens *private → specific people → my team(s) → my whole org → public*; a
  **personal-home** canvas omits the team/org rungs (*private → specific people → public*). "Org"
  excludes guests **by definition**.

**Boundary mechanics**
- **D4 — Guests are self-sufficient individuals.** A guest can create + own their own
  *private / specific-people* canvases, but never sees any org or team scope.
- **D5 — Operator configures the domain → org map.** The instance operator declares "these domains
  = Org X." Near-term that's just your member domain(s) vs everyone-else-is-guest.
- **D6 — Teams are self-serve.** Any **member** creates a team and invites other members; an org
  owner can oversee. Members-only — guests are never on a team.
- **D7 — Soft scoping now, subdomain-per-org later.** One DB + storage with `org_id` on
  `canvases`, enforced at the **service layer**. Going internet-facing later gives each org its own
  subdomain (`acme.host`) for browser-origin isolation; personal/guests stay on the main host.
  (Caveat carried to Phase 3: the session cookie is `Domain=.{baseHost}`-scoped today, so org
  subdomains would *share* a cookie unless P3 makes them host-scoped — see Phase 3.)

**Onboarding, structure, governance, cutover**
- **D8 — Invite-only now, signup-ready later.** A member/admin invites a guest's email (today's
  `allowed_emails`) before they can sign in; the flow is built so flipping on open self-signup
  later is a config toggle.
- **D9 — Every user gets a personal space; org is additional.** A "Personal" workspace for
  everyone, plus members additionally belong to their org — a workspace switcher (Personal / Acme).
  *Implementation: personal space = `canvas.org_id IS NULL`* (the **absence** of a tenant, never a
  reserved "personal org" row).
- **D10 — Instance operator governs; per-org governance is Phase 4.** No per-org admin console
  before then; the operator is the only admin. (Review correction: this is **Phase 4**, not the
  earlier "Phase 3/4".)
- **D11 — Auto-scope at cutover.** On deploy, existing `whole_org` shares clamp to org-members-only
  and brought-in guests lose that access (the fix). `specific_people` grants and `private` are
  preserved. A dry-run report precedes the live apply, and a post-apply verification confirms the
  result matches it (R8/R12).

## The model

- **Org** — an isolation boundary defined by **one or more verified email domains**, operator
  configured. **A domain maps to at most one org** (`org_domains.domain` is unique; a boot guard
  rejects a config that lists one domain under two orgs). **Phase 1 materializes exactly ONE org**
  (yours) and a boot guard rejects multi-org config until Phase 3 — so "which org scopes this
  action" is never ambiguous in P1.
- **Personal space** — every user's own workspace = `canvas.org_id IS NULL`. First class in the UI;
  needs no table; never a sentinel org row.
- **User** — a person, by email. Always has a personal space. Is a **member** of an org iff their
  verified email domain ∈ that org's domains (**exact match** on a normalized domain — see Identity
  rules), else a **guest**. Membership is **derived** from domain in Phase 1; explicit `org_members`
  rows arrive with Teams (Phase 2) as a superset, swapped behind the same resolver interface.
- **Team** — a members-only group **within** one org (Phase 2).
- **Canvas** — **owner = a user** (unchanged). **Home tenant = `org_id`** (an org the owner is a
  member of, or `NULL` = personal). The home tenant determines which scopes are even available.

### Identity & membership rules (review-hardened)

- **Server-derived only.** The membership set is computed server-side from the session-verified
  email, never from client input (§12.0 #1). The active workspace in the UI is a **filter hint**,
  never an authorization input — every endpoint re-derives `orgIds` from the session.
- **Domain match = exact, on a normalized domain.** `lower(strip-trailing-dot(domain))`; non-ASCII
  domains are rejected/punycode-folded (no homoglyph surprises). `u@acme.com` matches org domain
  `acme.com`; `u@eng.acme.com` does **not** (subdomain emails are a *different* domain) — so an org
  using `@eng.acme.com` addresses must enumerate that subdomain in `CANVAS_DROP_ORG_DOMAINS`. We
  bias to **narrower** membership (under-include is the safe failure for an isolation feature);
  domain-or-subdomain matching is a possible future config option, not the default.
- **Membership is independent of the sign-in allowlist.** Domain ∈ org_domains is the *only* thing
  that grants membership; `allowed_emails` / `ADMIN_EMAILS` grant **sign-in**, not membership (D2).

### The scope ladder (resolved)

| Home tenant | Available `access` scopes |
|---|---|
| **Personal** (`org_id` null) | `private` → `specific_people` *(invite any email, incl. guests)* → `public_link` *(admin-gated)* |
| **Org** (`org_id` set) | `private` → `specific_people` → `team` *(Phase 2)* → `whole_org` *(org members only)* → `public_link` *(admin-gated)* |

- **`specific_people`** is the **only** cross-boundary path (invite an external/guest by email).
- **`access` is single-valued**, so **`whole_org` + one external guest is NOT expressible** —
  org-wide *and* a single contractor can't coexist; use `specific_people` (named members + the
  guest) for that case. (Additive per-rung grants are a deliberate future model change, flagged not
  built.) Promoting `specific_people`→`whole_org` leaves the guest's allowlist row in place but
  denied; demoting back restores it — tested in P1.
- **`team` / `whole_org`** never cross the org wall and never reach guests.
- **`public_link`** stays admin-gated (the one truly-open rung).
- **Gallery** becomes per-org: an org's gallery shows org-listed canvases to that org's members
  only. Personal/guests get no org gallery.

### Isolation invariant — THREE seams, by necessity (review correction)

Isolation is **not** one seam. The per-canvas serve path can run the decision table, but list and
clone-eligibility queries cannot evaluate a per-row function — so org-scoping is enforced in three
places, each with rejection-first tests:

1. **Serve — `decideCanvasAccess`** (`canvas/authorization.ts`): `whole_org` allows only when
   `viewer.orgIds.has(canvas.orgId)`. A `whole_org` canvas with **`org_id IS NULL`** is **explicitly
   denied** (not left to `Set.has(null)`). A non-member → §12.0 **not found**.
2. **Enumerate — the shared list predicate** (`galleryVisibilityFilters`, used by `listGallery`,
   facets, trending): add `org_id IS NOT NULL AND org_id ∈ viewer.orgIds`. Guests/personal → empty
   org gallery.
3. **Clone — `findCloneableTemplate`**: the same `org_id ∈ viewer.orgIds` clause, so a guest or an
   org-B member can't clone an org-A template by id (over HTTP **or** MCP).

The caller's **`orgIds`** rides the server-side `Principal` (member = the derived set; guest = ∅)
and **every** principal-fabrication site must populate it — the gateway, `requestPrincipal`, the
**realtime hub's re-auth fallback** (`hub.ts` rebuilds a member principal on revalidate), the MCP
caller, and screenshot capture. Make the resolver dependency-injected and require `orgIds` on
`memberPrincipal(...)` so the compiler enforces this. The same service layer backs HTTP **and** the
MCP tools (agent-native parity) — but note MCP `list_canvases` is owner-scoped, so the UI's new
org-gallery needs an explicit MCP decision (a scoped `list_gallery` tool, or a documented deferral).

## Requirements

Phase tags in brackets; plans trace these R-IDs.

- **R1 [P1] Org + domains model.** `orgs` + `org_domains` tables (`domain` unique); operator
  configures the map (reuse `ALLOWED_EMAIL_DOMAINS` as the seed); a boot guard rejects a domain
  mapped to two orgs and (P1) any multi-org config. Additive dual-dialect migration; parity test
  green.
- **R2 [P1] Canvas home tenant.** Additive nullable `canvases.org_id` FK (null = personal). Reserve
  `'team'` in the `access` CHECK now (additive; `decideCanvasAccess` rejects it until P2) so P2
  avoids a SQLite table-rebuild.
- **R3 [P1] Member/guest classification.** A **dependency-injected** resolver computes the caller's
  org membership set server-side from the normalized verified domain (exact match), independent of
  `allowed_emails`/`ADMIN_EMAILS`. `orgIds` on the `Principal`; guests = ∅. **Rejection-path tested
  first**; spoof attempts (client-asserted org) ignored.
- **R4 [P1] Re-scope `whole_org`.** `decideCanvasAccess`: allow iff `viewer.orgIds.has(canvas.orgId)`
  and `org_id` non-null; explicit deny on null; non-member → 404. Write-side: a member may only set
  an `org_id` they belong to; guests only personal.
- **R5 [P1] Org-scope all THREE seams.** The decision table (R4) **plus** the shared list predicate
  **plus** `findCloneableTemplate`. Rejection tests: a non-member sees an org canvas in **none** of
  serve, gallery, facets, owner-list, or clone.
- **R6 [P1] Workspace surface.** `/api/me` returns the caller's org(s) + `isGuest` (no `role` field
  in P1 — no role model yet). Dashboard Personal/Org switcher; create picks the home tenant (members
  default Org); the active workspace is **UX-only, never an authz input**. Guests see only Personal.
- **R7 [P1] MCP parity.** Home-tenant on create (`create_canvas` gains `org_id`, validated against
  membership), the re-scoped `whole_org` write, org-filtered/clone-gated reads — same service layer,
  same checks. The org-gallery-browse-over-MCP gap is resolved explicitly (scoped tool or documented
  deferral).
- **R8 [P1] Cutover migration (auto-scope).** Seed the org from config; backfill `org_id` on
  existing canvases by **owner domain** with a `WHERE org_id IS NULL` predicate (idempotent, resumes
  after partial failure); **clamp** any `whole_org` canvas that resolves to `org_id NULL`
  (guest-owned) down to `private`; `whole_org` becomes members-only automatically. `specific_people`
  / `private` preserved.
- **R9 [P2] Teams.** `org_members` (+ reconcile that cascades to team membership) + `teams` +
  `team_members` + `canvas_teams`; self-serve team CRUD + invites (members only); the `team` rung;
  team-scoped gallery; MCP **and docs** parity.
- **R10 [P3] Multi-org readiness.** Allow >1 org; operator provisioning; **subdomain-per-org**
  routing + host-scoped cookies for real origin isolation; per-org quotas (with a usage-rollup
  denormalization); reconcile with the existing canvas URL mode.
- **R11 [P4] Public-facing.** Self-serve **verified** domain claim (DNS TXT / email + homoglyph
  checks); open guest-signup toggle + abuse controls; a per-org admin console + role model.
- **R12 [P1] Safe cutover tooling.** A `tenancy:plan` dry-run reporting, per user/canvas, the access
  deltas (gains **and** losses, incl. allowlist/admin reclassification), run **before every apply**;
  the live migration is idempotent + additive, and a **post-apply verification** asserts the live
  state matches the dry-run.
- **R13 [P2/P3] Lifecycle reconciliation.** Define what happens when a domain is removed (a member
  becomes a guest) or an owner leaves the org while a canvas stays `whole_org`: reconcile stale
  `org_members`/`team_members`, surface "stranded" org canvases for a now-guest owner, and decide
  org-canvas ownership reassignment. (Captured now because P1's owner-bypass + guest-only-Personal
  UI can otherwise strand a canvas.)
- **R-sec [all] Invariant tests.** Every phase tests **rejection** paths first: a guest/non-member
  hitting `whole_org`/`team` via serve, list, facets, clone, realtime re-auth, or OG/social-preview
  → denied; membership server-only; admins not a cross-org bypass; guest principals stay scoped.

## Phasing

| Phase | Ships | Requirements | Solves |
|---|---|---|---|
| **1 — Org boundary + foundation** | orgs+domains, `canvases.org_id` (+reserved `team` CHECK), DI membership resolver, the three org-scoping seams, workspace surface, MCP parity, auto-scope migration + dry-run + post-apply verify | R1–R8, R12, R-sec | **Your stated pain — guests walled off from org content** |
| **2 — Teams** | `org_members`(+reconcile)+`teams`+`team_members`+`canvas_teams`, self-serve teams, the `team` rung, team gallery, MCP/docs | R9, R13, R-sec | intra-org sharing groups |
| **3 — Multi-org ready** | >1 org, operator provisioning, subdomain-per-org + host-scoped cookies, per-org quotas | R10, R13, R-sec | host several isolated orgs |
| **4 — Open to internet** | verified self-serve claim, guest-signup toggle + abuse controls, per-org admin console + roles | R11, R-sec | public SaaS (the **only** phase where per-org governance lands) |

## Open items (defaulted unless changed)

1. **Member default workspace** on create → **Org** (switcher to Personal).
2. **Existing private member canvases** at cutover → home = **Org** (scope still `private`).
3. **Quotas/limits per org** → deferred to Phase 3 (stay global/per-user; personal = the per-user
   floor).
4. **Vocabulary** → "Organization / Team / Personal" in product copy (model term *tenant* = org |
   personal). Confirm before it's stamped across UI/API/MCP/docs.
5. **URL wrinkle (Phase 3):** the existing *canvas* URL mode (path vs subdomain) is a separate axis
   from org-subdomain; reconcile + decide host-scoped cookies when Phase 3 is planned.
6. **Subdomain-email matching** (Identity rules) → **exact** by default; operators enumerate
   subdomains. Flip to domain-or-subdomain only via explicit future config.
7. **Member→guest / owner-leaves lifecycle** (R13) → reconcile rules decided when Phase 2/3 are
   planned at depth; P1 only needs the owner-bypass to keep working + the dry-run to surface it.

## Risks / watch-list

- **§12 regression surface.** Re-scoping `whole_org` is an authorization change on a live path — the
  highest-risk edit in the project, and it spans **three** seams. Mitigation: name all three
  explicitly, rejection-first tests on each, mandatory security/adversarial review per phase.
- **Silent cutover exposure or removal.** Auto-scope changes who can see existing canvases.
  Mitigation: the dry-run (gains **and** losses) is reviewed before every apply; clamp `whole_org`
  +null→private; post-apply verification; additive + idempotent (`WHERE org_id IS NULL`).
- **Realtime principal without `orgIds`.** A re-auth that omits `orgIds` either drops every member
  (self-DoS) or keeps a non-member socket. Mitigation: `orgIds` required on `memberPrincipal`; the
  hub fallback populated; a revalidate rejection test.
- **The clone-template door.** A guest cloning an org template by id bypasses the gallery filter.
  Mitigation: gate `findCloneableTemplate` (seam #3), HTTP **and** MCP.
- **Membership staleness when explicit rows land (P2).** Removing a domain must reconcile derived
  `org_members` **and** cascade to `team_members` (else a now-outsider keeps team access).
- **Domain identity tricks.** Plus-addressing, subdomain emails, trailing-dot FQDNs, homoglyph/IDN.
  Mitigation: normalization in P1 (exact + ASCII); homoglyph checks in the P4 self-serve claim.
- **Proxy mode.** External rungs are disabled and the guest resolver is *not mounted* in proxy mode;
  preserve that.
- **Scope creep into a full RBAC.** D10 keeps governance at the operator until Phase 4; no per-org
  role matrix before then.

## Review corrections (what the 5-lens plan review changed)

- The "single `decideCanvasAccess` seam" framing was **wrong** → three seams (serve table, list
  predicate, clone-template), each rejection-tested.
- `decideCanvasAccess` is in `canvas/authorization.ts` (not `owner-guard.ts`); `BACKUP_TABLE_ORDER`
  / `ops/backup.ts` / `docs/ops.md` are on the **unmerged** backup PR, **not** this branch — plan
  refs corrected.
- `allowed_emails` / `ADMIN_EMAILS`-on-non-org-domain users are **guests**, not members (supersedes
  the schema comment); the cutover flags the reclassification.
- `whole_org` + `org_id NULL` is **explicit-deny**; the cutover **creates** such rows (guest-owned
  `whole_org`) and must clamp them.
- Realtime re-auth, the clone-template path, and the gallery SQL all needed explicit `orgIds`
  scoping; the resolver is DI and `memberPrincipal` requires `orgIds`.
- D10 governance is **Phase 4**; reserve `'team'` in the CHECK in P1 to avoid a SQLite rebuild in
  P2; add the member→guest / owner-leaves lifecycle as R13.

# Shared With Me Discovery Plan

Origin: `docs/brainstorms/2026-06-24-shared-with-me-requirements.md`

## Summary

Add a first-class **Shared** dashboard section for signed-in users to find and open non-owned canvases that were deliberately made discoverable to them. The feature separates **access** from **listability**:

- Direct `specific_people` grants are discoverable to the granted user.
- `team` and `whole_org` canvases are discoverable only when the owner opts into `discoverability = "listed"`.
- `public_link`, private, unpublished, archived, disabled, deleted, expired, revoked, and owner-owned canvases are excluded.
- Password-protected canvases may appear when otherwise discoverable; opening them still hits the password gate.

The access decision remains unchanged: the new field controls only enumeration in Shared and Whole-org gallery eligibility. It must never widen who can open a canvas by URL.

## Key Decisions

1. Persist listability as a canvas column
   - Add `canvases.discoverability` with values:
     - `link_only` (default): people can open only if they have the URL and access allows them.
     - `listed`: people with access may find it in Shared.
   - Existing data migrates to `link_only` to preserve access while avoiding surprise directory exposure,
     except Whole-org rows already opted into the Gallery keep that listing intent by backfilling
     `discoverability='listed'`.

2. Scope of `discoverability`
   - The UI exposes the switch only for `team` and `whole_org`.
   - `specific_people` remains inherently discoverable to direct grantees in Shared.
   - `public_link` is excluded from Shared. Public discovery stays the Gallery.
   - When access changes away from `team`/`whole_org`, reset discoverability to `link_only`.

3. Gallery eligibility
   - Public-link canvases remain Gallery eligible when the existing gallery preconditions hold.
   - Whole-org canvases are Gallery eligible only when `discoverability = "listed"` and the viewer is in the canvas org.
   - Team and Specific-people canvases are never Gallery eligible.

4. One canonical shared read
   - Add a shared service/repository path used by both `GET /api/canvases/shared` and MCP `list_shared_canvases`.
   - Fold the current Teams page discovery block into the new Shared page so users have one place to find non-owned canvases.
   - Keep the old team-only implementation only as needed for compatibility tests during the transition; do not build new UX around it.

5. Search and browse
   - Shared uses the same forgiving tokenized search posture as Your canvases and Gallery.
   - Search covers canvas title, description, tags, slug, owner display name, and visible access context such as the granted team name.
   - Shared supports grid and list layouts with thumbnails, pagination, and remembered layout preference. Job to be done: find something and open it.

6. Landing behavior
   - If a user lands on `/` with no owned canvases and no explicit deep link/return target, redirect or guide them to Shared when they do have shared canvases.
   - Explicit routes and `returnTo` values always win.

## Units

### U1. Data model and settings invariant

Files:

- `packages/shared/src/db/schema.pg.ts`
- `packages/shared/src/db/schema.sqlite.ts`
- `packages/shared/src/db/types.ts`
- `apps/server/src/canvas/settings-update.ts`
- `apps/server/src/db/repositories/canvases.ts`
- `apps/server/src/canvas/settings-update.test.ts`
- `drizzle/pg/*`
- `drizzle/sqlite/*`

Work:

- Add `CanvasDiscoverability = "link_only" | "listed"` and a schema CHECK/default for both dialects.
- Generate additive migrations for SQLite and Postgres.
- Include discoverability in owner projections and settings patches.
- Extend `resolveSettingsUpdate` so:
  - setting `discoverability` never bypasses share/publish/public-link gates,
  - access outside `team`/`whole_org` resets to `link_only`,
  - `whole_org` gallery listing requires `listed`,
  - setting `link_only` on a Whole-org gallery-listed canvas clears `galleryListed` and `galleryTemplatable`,
  - unpublish/archive/public-link revoke sweeps clear discoverability with the existing publication fields.
- Update gallery visibility filters so Whole-org gallery browse requires `listed`; Public-link browse does not.

Focused tests:

- Settings resolver accepts and persists listed Team/Whole-org.
- Non-listable access resets to `link_only`.
- Whole-org gallery listing fails unless listed, or succeeds in the same patch that sets listed.
- Setting `link_only` clears Whole-org gallery/template flags.
- Gallery query excludes Whole-org link-only rows and includes listed Whole-org rows.

### U2. Canonical Shared service, HTTP route, and MCP parity

Files:

- `apps/server/src/teams/sharing.ts` or new `apps/server/src/canvas/shared-list.ts`
- `apps/server/src/routes/management.ts`
- `apps/server/src/mcp/server.ts`
- `apps/server/src/mcp/tool-kit.ts`
- relevant server and MCP tests

Work:

- Implement `listSharedCanvases` as the single service for non-owned discoverable canvases.
- Candidate sources:
  - direct active allowlist member rows for `specific_people`,
  - team grants where caller is a live team member and canvas discoverability is `listed`,
  - Whole-org canvases where caller is a live member of the canvas org and discoverability is `listed`.
- Fixed filters:
  - exclude owner-owned canvases,
  - require `status = active`,
  - require `currentVersionId IS NOT NULL`,
  - require unexpired share,
  - exclude `public_link`.
- Return a display projection only: id, slug, URL, title, description, tags, preview hint, password flag, owner display identity, access source, updated/published timestamps as available.
- Add `GET /api/canvases/shared?q=&sort=&limit=&offset=` with safe clamps.
- Add MCP `list_shared_canvases` with query/limit/offset and the same projection.
- Keep MCP owner-only `update_canvas` parity by adding the discoverability input and output.
- Update or deprecate `list_shared_with_teams` so existing callers do not get a divergent policy.

Focused tests:

- Direct grant appears for the grantee and not the owner.
- Team link-only does not appear but URL access is unaffected.
- Team listed appears with the team name in access context.
- Whole-org link-only does not appear; Whole-org listed appears only for members.
- Public-link, expired, unpublished, archived, disabled, deleted, and own canvases are excluded.
- Search matches canvas text, owner name, and team name.
- Pagination returns stable total/limit/offset.
- MCP returns the same rows as HTTP and `update_canvas` can set discoverability.

### U3. Dashboard Shared route and Share tab controls

Files:

- `apps/dashboard/src/router.tsx`
- `apps/dashboard/src/app-layout.tsx`
- `apps/dashboard/src/lib/api.ts`
- `apps/dashboard/src/lib/queries.ts`
- `apps/dashboard/src/lib/mutations.ts`
- `apps/dashboard/src/lib/shared-view.ts`
- `apps/dashboard/src/routes/shared.tsx`
- `apps/dashboard/src/routes/canvas.share.tsx`
- `apps/dashboard/src/routes/teams.tsx`
- relevant dashboard tests

Work:

- Add `/shared` route and nav item.
- Build Shared page with:
  - search box,
  - pagination,
  - grid/list toggle,
  - persisted Shared layout preference,
  - thumbnail cards/rows reusing `CanvasGridCard` and `CanvasListRow`,
  - access context badges (`Direct`, team name, `Whole org`),
  - owner display,
  - open/copy actions only.
- Add API hooks and invalidations under the `canvases` query prefix.
- Add Share tab discoverability controls:
  - show for Team and Whole org only,
  - copy says URL access is unchanged; listing controls whether people with access can find it in Shared,
  - Whole-org Gallery toggle is disabled until discoverability is `listed`,
  - changing away from Team/Whole org hides the control and the server resets it.
- Fold Teams page “Shared with your teams” into a link/notice pointing to Shared, or remove it if the Shared nav is sufficient.
- Add empty-state logic from `/` for no owned canvases + shared canvases.

Focused tests:

- Nav renders Shared and route title updates.
- Shared page fetches query/page/view and renders grid/list rows with owner/access context.
- Search changes URL and resets page.
- View preference persists independently from Gallery/Your canvases.
- Teams page no longer renders a second team-only discovery grid.
- Share tab shows and saves discoverability for Team/Whole org, and gates Whole-org Gallery listing.

### U4. Documentation and agent references

Files:

- `README.md`
- `docs/site/authoring/sharing.md`
- `docs/site/authoring/teams.md`
- `docs/site/authoring/create-and-publish.md`
- `docs/site/agents/mcp.md`
- `docs/site/agents/llms.md`
- any generated docs output required by `pnpm docs:build`

Work:

- Document the distinction between access, Shared discoverability, and Gallery listing.
- Make clear that `link_only` preserves URL access but prevents listing in Shared.
- Document Gallery eligibility: Public-link or Whole-org+listed only; Team/Specific people never Gallery.
- Update Teams docs to point discovery to Shared instead of Teams-only.
- Document MCP `list_shared_canvases` and `update_canvas.discoverability`.
- Keep wording org-agnostic and avoid implying URL secrecy is the primary control.

Focused tests:

- Run docs build or the smallest repo-supported docs validation if available.
- Search docs for stale `list_shared_with_teams` and “Teams -> Shared with your teams” references.

### U5. Review and verification

Work:

- During implementation, run targeted SQLite-backed tests only:
  - settings resolver tests,
  - shared service/route tests,
  - MCP tests touched by the feature,
  - dashboard tests touched by the feature.
- After implementation, run:
  - `pnpm test:sqlite` or focused SQLite-backed root tests,
  - dashboard focused tests,
  - `pnpm typecheck`,
  - `pnpm lint` if time allows before review.
- Run `ce-code-review` with `base=origin/main` and this plan.
- Apply real findings, especially auth/discoverability/MCP parity issues.

Final full dual-dialect test remains deferred until Mark gives final feedback, per the current testing constraint.

## Risks and Guards

- **Enumeration widening:** Shared must only list rows the viewer already has access to, and only where the owner opted into discoverability except direct grants. Tests cover every rung.
- **Gallery drift:** Gallery filters and settings resolver must agree. A stale row with `galleryListed=true` and `discoverability=link_only` must not be visible.
- **MCP parity drift:** HTTP and MCP must call the same shared service and settings resolver.
- **Search leakage:** Search runs only over the already-authorized candidate set.
- **Data preservation:** Migration is additive with a default; no live data is deleted.
- **Router typing:** Follow the repo’s loose-search pattern for routes where TanStack search unions are brittle.

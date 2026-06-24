---
title: "Shared with me discovery"
date: 2026-06-24
topic: shared-with-me
type: requirements
---

# Shared with me discovery

## Summary

Add a top-level **Shared** section where signed-in members and external people can find and open non-owned canvases that are discoverable to them: direct shares, plus Team or Whole org canvases whose owners chose to list them for people with access. Split access from discoverability so Team and Whole org canvases can remain link-only by default, while owners can opt them into being listed for people with access and, for eligible Whole org canvases, the Gallery.

---

## Problem Frame

canvas-drop now supports direct people shares, team shares, Whole org links, and public links, but the dashboard has no single place where a non-owner can find the canvases they can open. The Gallery is intentionally opt-in and broad-discovery shaped. The Teams page has a "Shared with your teams" section, but it only covers one access path and is buried under team management.

The job to be done is simple: a signed-in person wants to find something shared with them and open it. That person may be an org member or an external/no-org person whose first useful landing state is not "your empty canvas list."

Whole org and Team access also need a clearer distinction between "allowed to open with the URL" and "listed somewhere." A Google Drive-style mental model is useful here, but the product copy should stay literal: "Don't list" means link-only; "List for people with access" means it appears in Shared for the people who already have access.

---

## Key Decisions

- **Shared is a first-class section.** It belongs in primary navigation, not inside Gallery or Teams, because it answers a separate "what can I open?" job.
- **Access and discoverability split.** Access says who may open a canvas; discoverability says whether those allowed people can find it without already having the URL.
- **Team and Whole org default to link-only.** Existing "with the link" semantics stay intact unless the owner opts into listing.
- **Specific people is inherently listed for the added people.** A direct share should appear in Shared for the person who was added, because that is the point of the direct grant.
- **Shared is identity-scoped, not public discovery.** Public links stay out of Shared; Gallery and the URL itself remain the public-link discovery paths.
- **Gallery is sequential for Whole org.** A Whole org canvas must be listed for people with access before it can be listed in the Gallery.

---

## Actors

- A1. **Viewer** - a signed-in member or external/no-org person looking for a canvas they can open.
- A2. **Owner** - the person who owns a canvas and controls its access and discoverability.
- A3. **Team member** - a viewer who reaches a canvas through a team grant.
- A4. **Org member** - a viewer who reaches a canvas through Whole org access.
- A5. **Agent** - an MCP caller acting for a signed-in user, subject to the same access and discoverability rules.

---

## Requirements

**Shared Section**

- R1. The dashboard must expose a top-level **Shared** section for signed-in users.
- R2. Shared must list only canvases the viewer can currently open and does not own.
- R3. Shared must include direct Specific people shares for the added viewer.
- R4. Shared must include Team canvases only when the canvas is set to **List for people with access** and the viewer belongs to a granted team.
- R5. Shared must include Whole org canvases only when the canvas is set to **List for people with access** and the viewer belongs to the canvas's org.
- R6. Shared must exclude Public link canvases.
- R7. Shared must exclude expired, revoked, disabled, unpublished, deleted, or otherwise inaccessible canvases.
- R8. Password-protected canvases must appear in Shared when the viewer otherwise has access; opening them may still require the password gate.
- R9. When sign-in has no explicit return target or deep-link destination, a user with no owned canvases and at least one Shared canvas must land on Shared by default.

**Find and Open**

- R10. Shared must support grid and list views with thumbnails.
- R11. Shared must default new users to grid view and remember each user's last grid/list choice.
- R12. Shared search must be as capable as the personal canvas search, including forgiving search over title, description, tags, slug, and Shared-specific visible context such as owner name and granted team name.
- R13. Shared must support pagination.
- R14. Shared rows and cards must prioritize how the viewer got access: Direct, Team name, or Whole org.
- R15. Shared rows and cards must show the owner as supporting context.
- R16. Shared rows and cards must focus on opening the live canvas, not owner management actions.

**Access Discoverability**

- R17. Team and Whole org canvases must have a discoverability setting with two user-facing choices: **Don't list** and **List for people with access**.
- R18. Team and Whole org canvases must default to **Don't list**.
- R19. A **Don't list** Team or Whole org canvas remains openable by URL for allowed viewers but does not appear in Shared.
- R20. A **Don't list** Whole org canvas must not be eligible for Gallery listing.
- R21. Setting a Team or Whole org canvas to **List for people with access** must not widen who can open it.
- R22. Changing discoverability must take effect on the next Shared/Gallery read.

**Gallery Relationship**

- R23. Gallery listing must remain a separate owner opt-in after a canvas is listed for people with access.
- R24. Only Whole org and Public link canvases may be Gallery-listable.
- R25. Specific people and Team canvases must not be Gallery-listable.
- R26. Whole org canvases must be Gallery-listable only when they are also **List for people with access**.
- R27. Existing Gallery constraints still apply: a listed canvas must be published, unexpired, unprotected, and otherwise visible under the Gallery rules.

**Agent Parity**

- R28. The owner-facing discoverability setting must have MCP parity with the dashboard.
- R29. The signed-in Shared list must have MCP parity with the dashboard read, using the same access and discoverability rules.

---

## Key Flows

- F1. **Open a link-only team canvas**
  - **Trigger:** An owner shares a Team canvas and leaves discoverability at **Don't list**.
  - **Actors:** A1, A2, A3
  - **Steps:** The owner sends the URL; the team member opens it; the canvas does not appear in Shared or Gallery.
  - **Outcome:** Link-only access stays private-by-URL without blocking legitimate access.
  - **Covers:** R4, R17, R18, R19, R21

- F2. **Find a listed team or org canvas**
  - **Trigger:** An owner changes a Team or Whole org canvas to **List for people with access**.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** The viewer opens Shared, searches or pages through results, sees why the canvas is available, and opens it.
  - **Outcome:** Allowed viewers can find the canvas without already having the URL.
  - **Covers:** R1, R2, R4, R5, R10, R12, R13, R14, R16

- F3. **External person lands on Shared**
  - **Trigger:** An external/no-org person signs in after being added to a canvas and has no owned canvases.
  - **Actors:** A1, A2
  - **Steps:** The pending grant materializes; when there is no explicit return target, the app lands the person on Shared; the direct share appears there.
  - **Outcome:** External people do not land on an empty owner canvas list when their real job is opening a shared canvas.
  - **Covers:** R3, R9, R14, R15

- F4. **List a Whole org canvas in Gallery**
  - **Trigger:** An owner wants a Whole org canvas to appear in the Gallery.
  - **Actors:** A2, A4
  - **Steps:** The owner first sets it to **List for people with access**, then enables Gallery listing if the remaining Gallery constraints are met.
  - **Outcome:** Gallery remains a stronger discovery opt-in, not a way around link-only behavior.
  - **Covers:** R20, R23, R24, R26, R27

- F5. **Lose access**
  - **Trigger:** Access is revoked, expires, or the canvas stops being openable.
  - **Actors:** A1, A2
  - **Steps:** The viewer refreshes Shared or returns later.
  - **Outcome:** The canvas no longer appears.
  - **Covers:** R2, R7, R22

---

## Acceptance Examples

- AE1. **Covers R2, R3, R17.** Given a canvas is shared with a specific signed-in person, when that person opens Shared, then the canvas appears even without a separate discoverability setting.
- AE2. **Covers R4, R17, R19.** Given a Team canvas is **Don't list**, when a team member opens Shared, then the canvas is absent; when they open its URL, access is allowed.
- AE3. **Covers R5, R18, R19.** Given a Whole org canvas keeps the default **Don't list**, when an org member opens Shared, then the canvas is absent even though the URL works for them.
- AE4. **Covers R4, R5, R10, R12, R13.** Given a Team or Whole org canvas is **List for people with access**, when an allowed viewer searches by canvas text or visible owner/team context, or pages through Shared, then the canvas can appear in grid and list views with its thumbnail.
- AE5. **Covers R6, R23, R24.** Given a Public link canvas exists, when a signed-in user opens Shared, then it is absent; when the owner lists it in Gallery under existing rules, it may appear in Gallery.
- AE6. **Covers R8, R27.** Given a password-protected Whole org canvas is **List for people with access**, when an org member opens Shared, then the canvas appears; when the owner tries to list it in Gallery, Gallery remains blocked until the password is removed.
- AE7. **Covers R9.** Given a newly signed-in external person owns no canvases, has one current direct share, and has no explicit return target, when the dashboard chooses a landing surface, then it lands on Shared.
- AE8. **Covers R14, R15.** Given a viewer has a direct share, a team share, and a Whole org share, when Shared renders them, then each item shows the access path first and the owner as secondary context.
- AE9. **Covers R7, R22.** Given a listed shared canvas expires or is revoked, when the viewer next loads Shared, then the canvas is gone.
- AE10. **Covers R28, R29.** Given an MCP caller reads Shared or updates discoverability, when the same dashboard action would include or deny a canvas, then MCP returns the same result.

---

## Success Criteria

- A signed-in viewer can find a current listed or directly shared non-owned canvas by name, description, tag, slug, owner, or visible access context and open it from Shared.
- External/no-org users with shared access are not stranded on an empty owner canvas page.
- Owners can keep Team and Whole org canvases link-only without accidentally listing them in Shared or Gallery.
- The Gallery remains an intentional broad-discovery surface, not a side effect of access.

---

## Scope Boundaries

- Public links do not appear in Shared.
- Shared does not track "public links I opened before" or browsing history.
- Shared does not show owned canvases.
- Shared does not preserve a history of expired, revoked, disabled, deleted, or unpublished shares.
- Team canvases are not Gallery-listable.
- The feature does not add notifications for new shares.

---

## Dependencies and Assumptions

- The Shared list is access-invariant-sensitive: a canvas appears only if the server would allow the viewer to open it at read time.
- Existing personal canvas search establishes the expected search quality for Shared.
- Existing Gallery rules already require published, unexpired, unprotected, listed, visible canvases.
- Existing Team shared-list behavior should be folded into or redirected toward the new Shared section so team-shared canvases are not split across two user-facing discovery surfaces.
- Any persisted discoverability state must migrate existing Team and Whole org canvases to **Don't list** without changing who can open their URLs.

---

## Outstanding Questions

### Resolve before planning

- None. The access/discoverability model, defaults, Gallery relationship, and Shared inclusion rules are pinned.

### Deferred to planning

- Exact storage shape for the Team and Whole org discoverability setting.
- Exact route name and navigation placement details for Shared.
- Whether Shared reuses the personal canvas sort axes exactly or starts with a narrower default sort set.
- How the existing Teams page changes once Shared becomes the canonical place to find team-shared canvases.

---

## Sources and Current-State References

- `BUILD_BRIEF.md` - access ladder, "with the link" Whole org posture, Gallery as opt-in discovery, and access invariants.
- `README.md` - current public product language for the sharing ladder and auth-delegated access.
- `docs/brainstorms/2026-06-23-auth-delegated-access-governance-requirements.md` - Add person, pending grants, and external/no-org access model.
- `docs/solutions/2026-06-21-teams-parity-shared-helpers-and-listforuser.md` - warning that HTTP and MCP sharing reads must share logic.
- `apps/dashboard/src/routes/canvas.share.tsx` - current Share tab, access ladder copy, and Gallery eligibility UI.
- `apps/server/src/db/repositories/canvases.ts` - current owner search, Gallery visibility filters, and allowlist access helpers.
- `apps/dashboard/src/routes/teams.tsx` - current "Shared with your teams" section.
- `apps/server/src/teams/sharing.ts` - current shared-with-teams read behavior.

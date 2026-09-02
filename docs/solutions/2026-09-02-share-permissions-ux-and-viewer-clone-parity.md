---
title: Share permissions hierarchy and viewer clone parity
type: design
area: sharing
date: 2026-09-02
---

# Share permissions hierarchy and viewer clone parity

The Share page had the right authorization model but presented several concepts at the same visual weight: adding people, changing row roles, widening the audience, password and expiry, discovery, and ownership transfer. The clone service also let a team-granted viewer copy an eligible canvas while denying an otherwise identical directly granted viewer.

## Make the information order match the authorization order

The useful hierarchy is:

1. **People and teams with direct access** — the list that always applies.
2. **General access** — who else gets in: Restricted, Whole org, or Public link.
3. **Protection** — password and expiry modifiers.
4. Discovery controls — org listing and gallery/template settings.
5. **Advanced** — destructive or identity-changing owner actions such as transfer.

This makes the UI explain the same predicate the server evaluates. The People and Teams tabs change only the input accepted by one add form; they do not create two access lists. Row roles use compact native selects and secondary actions use the standard overflow menu, so ordinary maintenance does not compete with the page's primary controls.

Copy must describe the layer it belongs to. “No one else has direct access yet” remains true when Whole org or Public link is selected; “Only you can open this” did not. Likewise, the list introduction says General access never removes listed people or teams instead of promising they can always open, because expiry and password protection can still apply to viewers.

## Lifting transfer state needs a refresh contract

Moving ownership transfer out of each access row and into owner-only Advanced presentation also moves its data dependencies. The list reports eligible transfer candidates to its parent, and the parent increments an explicit refresh key after a successful transfer so the owner row and candidate set are reloaded together. The existing generation guard and null-on-load behavior remain important: a late response from the previous canvas must not repopulate stale list-derived copy or actions.

## Grant shape should not change the viewer capability

Direct and team viewer grants both authorize the same published bytes. Clone eligibility now uses one resolver for all paths:

- active owner or editor;
- org-scoped, listed gallery template;
- signed-in direct or team viewer of an active, published, unexpired, password-free canvas.

General access alone does not grant cloning. Pending invitations have no user principal yet, retained legacy guests are not members, and no-role members stay opaque not-found. Archived, disabled, deleted, expired, password-protected, and unpublished sources fail the same way for direct and team viewers. Keeping this in one service avoids HTTP/MCP drift and removes a capability difference caused only by how the same viewer was added.

The result is intentionally durable. A clone is a new, unpublished Restricted canvas owned by the viewer, with an empty direct-access list, backend off, and a fresh slug and deploy key. Revoking the source grant later does not revoke the copy; that is the existing clone-as-template contract, now made explicit in user and agent documentation.

## Treat documentation screenshots as behavior artifacts

The old tour image encoded the previous labels and control hierarchy. Browser QA at desktop and mobile widths verified wrapping, focus movement between add tabs, and the separated Advanced section; regenerating the committed screenshots kept the marketing tour and docs aligned with the actual page. UI terminology changes are incomplete until generated docs and screenshots move with the code.

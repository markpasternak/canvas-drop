---
title: Multi-account sign-in — a session jar beside the session cookie, and a 404 that only speaks to the holder
date: 2026-10-27
category: auth
---

# Multi-account sign-in: session jar + holder-only 404 probe

Plan: `docs/plans/2026-10-27-001-feat-multi-account-switching-plan.md`. Read with
[[2026-06-13-auth-invariant-checklist]] and [[2026-06-16-oidc-subdomain-cookie-and-returnto]].

## Keep the active cookie exactly as it was

Several pre-gateway surfaces read `__canvasdrop_session` directly: `landingGate`,
`/welcome`, the social-preview crawler gate, and the public-canvas resolver. Storing the
extra accounts in a **second** cookie (`__canvasdrop_accounts`) instead of reshaping the
first one meant none of them had to change. The jar holds raw session tokens of ordinary
`sessions` rows, so revocation, expiry, admin blocking and the per-request gateway checks
all apply to every account unchanged, and no migration was needed. Scope the jar cookie
like every other cookie on the OIDC path (`.{baseHost}` in subdomain mode).

## Bind the jar to the active session, or a canvas can plant accounts

A review caught what the green tests didn't. In subdomain mode, a canvas's own script can
`document.cookie = "__canvasdrop_accounts=…; domain=.base"` whenever no HttpOnly cookie
of that name exists yet. If the server trusts the jar as a plain token list, the canvas
author slips their own live session into a visitor's switcher (and into the 404's
"Continue as …"), and the visitor ends up working as the author after one click or one
"Sign out of this account". An HMAC over the list alone doesn't help, because the author
can copy a validly signed jar out of their own browser. The fix is to MAC the list
**together with the active session token** it was written alongside. The author never
learns the visitor's token, so a planted jar never verifies. Two consequences:

- Every write of the active cookie must re-MAC the jar (`write(c, active, jar)` does both).
- Never promote from a jar when there is no active cookie at all. The (expired) active
  token is still needed to verify the jar it was written with.

The same parent-domain cookie tossing could plant a bare `__canvasdrop_session` on a
signed-out browser. That predates this feature and is out of scope here.

## Never offer an account the gateway would refuse

Holding a live session is not enough: the user may since have been blocked or dropped from
the allowlist. `otherSignedInAccounts` filters on the same checks as the gateway, and
`/auth/switch` re-checks before swapping. Without that, the switcher offers a dead end
(switch, then a 403) and the canvas probe would answer for an account that can't sign in.

## The canvas 404 stays identical, except to the holder

`canvasAccess` deliberately collapses "missing" and "denied" into one `not_found` (§12.0).
The multi-account hint keeps that: the JSON body is untouched, the marker is set for both
cases, and the only difference the HTML can show ("Continue as …") comes from running the
**real** access decision for sessions this browser already holds. It tells the person
nothing they couldn't learn by switching. The existing "denied == missing" error-page test
needed one tweak: the path now also appears URL-encoded in the Switch account link's
`returnTo`, so normalize both forms.

## Switching is same-origin only, so canvases link to an apex chooser

In subdomain mode a canvas page is `same-site` with the apex, not `same-origin`. A POST
from the canvas 404 page would be refused by the same-origin check, which is the point: a
canvas must not be able to flip the visitor's account. So the 404 links to the
server-rendered chooser on the apex (`/auth/accounts?returnTo=…&account=…`), whose forms
are same-origin. That costs one extra click, the same as Google's account chooser.

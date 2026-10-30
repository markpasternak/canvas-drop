---
title: Multi-account sign-in and account switching
date: 2026-10-27
status: implemented
---

# Multi-account sign-in and account switching

Requested by Mark: stay signed in with several accounts at once (like Google Drive), switch
between them from the account menu, and on a canvas the current account can't open, get
an offer to switch to (or add) another account.

## Scope

- `oidc` mode only. In `proxy` mode the IAP owns identity; in `dev` mode it is fixed by
  config. Neither mode shows a switcher.
- One active account per browser (GitHub-style), not per tab (Google `/u/N/`). Per-tab
  would mean threading an account index through every canvas subdomain, SDK call and
  websocket.
- Up to five accounts per browser.

## Design

1. **Sessions (no migration).** Every account is an ordinary `sessions` row. The active
   token stays in `__canvasdrop_session`; the others ride in `__canvasdrop_accounts`
   (HttpOnly, scoped like the session cookie, `<mac>.<token>…`, most recently used
   first). The MAC covers the list and the active token, so a jar planted by a canvas
   script (parent-domain cookie) never verifies.
   `SessionService` gains `otherAccounts`, `switchTo`, `revoke` (current only, promotes
   the next) and `revokeAll`. `issue` keeps the previously active account instead of
   dropping it, retires older sessions for the account signing in, and revokes the least
   recently used one over the cap. `resolveUserId` promotes a held account when the
   active session ended elsewhere. Held accounts don't roll their expiry.
2. **Routes** (`auth/routes.ts`, oidc only): `GET /auth/accounts` (server-rendered
   chooser), `POST /auth/switch` and `POST /auth/logout/current` (same-origin only),
   `GET /auth/logout` (now signs out of every account), `GET /auth/login?add=1`
   (`prompt=select_account`). `GET /api/me/accounts` returns explicit summaries.
3. **Eligibility.** Every list, switch and probe skips accounts that couldn't pass the
   gateway right now (missing, blocked, not allowlisted).
4. **Canvas 404.** `canvasAccess` keeps the byte-identical JSON `not_found`. For a
   signed-in member's HTML navigation it sets `canvasNotFound`, and the error page offers
   "Use another account". `makeOtherAccountProbe` runs the real access decision for each
   held account (server-derived org membership + `resolveAccessContext` +
   `decideCanvasAccess`); on a match the page leads with "Continue as …", linking to the
   chooser with that account preselected.
5. **Dashboard.** `UserMenu` loads `/api/me/accounts` when opened and lists the accounts as
   form POSTs, plus "Add another account" and split sign-out once there are two.

## Security notes

- The probe only answers for sessions the browser already holds, so it reveals nothing the
  person couldn't learn by switching. A missing and a denied canvas still render
  identically unless one of the visitor's own accounts has access.
- A canvas can link to the chooser but can't switch: switch/sign-out refuse `same-site`
  and `cross-site` fetch metadata, and refuse any request on a canvas host (`/auth` also
  answers there, where a canvas's own fetch is same-origin). The chooser renders only on
  the instance host and sets `frame-ancestors 'none'`. Path mode shares one origin
  (documented reduced isolation, as for the management API).
- `session_switch` joins `session_create` / `session_revoke` in the audit log.
- MCP authorization connects the active account, so switch first.

## Signing in from a canvas link (added in review)

Mark also reported that signing in from a canvas link sometimes errored or landed
somewhere else. Causes and fixes:

- One shared OIDC transaction cookie, overwritten by a second sign-in (several tabs,
  restored tabs, two links). Now one cookie per sign-in, `__canvasdrop_oidc_<state>`.
- The gateway redirected background requests (SDK calls, assets, frames) to sign-in,
  replacing the real transaction and spending the login rate limit. Now only top-level
  page loads are redirected; the rest get `401`.
- Back onto a used callback showed an error while signed in. Now it goes to `/`.
- A `#route` in the link was lost. The signed-out preview page now carries it into the
  returnTo.

## Tests

`auth/session-accounts.test.ts` (jar lifecycle, cap, dedupe, forged entries, promotion,
cookie scope), `auth/multi-account.test.ts` (end to end through `buildApp`: canvas 404
probe, JSON unchanged, denied = missing, blocked skipped, chooser, same-origin switch,
open-redirect, sign-out handover, add-account), `http/error-pages.test.ts`,
`auth/routes.test.ts`, dashboard `user-menu.test.tsx`, and `auth/sign-in-flows.test.ts`
(a cookie-keeping browser and a fake OpenID provider: signed out into a canvas in both URL
modes, two tabs at once, background requests mid-sign-in, the Back button, a stale
cookie, a refused account's retry, a `#route`, and both wrong-account paths). All on both
dialects.

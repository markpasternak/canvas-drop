---
title: Multi-account switcher UI
date: 2026-10-30
status: implemented
---

# Multi-account switcher UI

Follow-up to [multi-account sign-in](2026-10-27-001-feat-multi-account-switching-plan.md).
Mark was happy with the logic but asked for a better UI, based on how Google, GitHub and
Slack present several signed-in accounts. He picked all three areas below.

## Account menu (dashboard `UserMenu`)

- The other accounts sit under a "Switch account" heading (`role="group"`), and the
  current account in the header gets a check once there is more than one.
- Every account has its own avatar tint, chosen from its email (`accountAvatarHue`, in
  `packages/shared/src/brand/avatar.ts` with a dashboard copy pinned to the same test
  vectors). Eight OKLCH hues, AA contrast checked in both themes.
- Sign-out names the account ("Sign out of a@x") beside "Sign out of all accounts".
- The account list is prefetched on trigger hover/focus, so labels don't change after
  the menu opens.
- At the limit, "Add another account" explains that adding one signs out the least
  recently used account. `/api/me/accounts` now also returns `maxAccounts`.
- Arrow keys, Home and End move between menu items (ARIA menu pattern).
- A switch leaves a session-storage note; after the reload the layout shows
  "Now using …" if the note matches the account that is now active.

## Wrong-account page (canvas 404, signed-in member, oidc)

- Another held account can open it: "Switch account to open this canvas", an account
  card ("Can open this canvas") and a primary "Switch to …".
- None can: "Can't open this canvas" / "This canvas doesn't exist, or X doesn't have
  access to it", the same for missing and forbidden canvases (§12.0 no-leak). The action
  is "Use another account" when the browser holds others, else "Sign in with another
  account". `canvasNotFound` gains `hasOtherAccounts`, which doesn't depend on the canvas.
- The footer says "Sign out of all accounts" when the browser holds several.

## Account chooser (`GET /auth/accounts`)

- Every row continues as its account (the current one links back to `returnTo`). The
  suggested account leads; otherwise the current one does.
- IdP photos (https only, `no-referrer`) or the tinted initial.
- Each other account has its own Sign out: `POST /auth/logout/account`, same-origin on
  the instance host only (same gate as `/auth/switch`), backed by
  `SessionService.revokeHeld`, which never touches the active session and audits
  `session_revoke`.

## Tests

`brand/avatar.test.ts`, dashboard `account-avatar.test.ts` and `user-menu.test.tsx`,
`auth/account-chooser.test.ts`, `auth/session-accounts.test.ts` (`revokeHeld`),
`auth/multi-account.test.ts` (per-account sign-out, cross-origin/canvas-host refusal,
page copy), `auth/sign-in-flows.test.ts`, `http/error-pages.test.ts`. Both dialects.

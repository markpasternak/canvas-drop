---
title: Diagnosing a login failure from prod logs — and why the OIDC callback used to deny silently
type: bug
area: auth
date: 2026-08-13
---

A colleague reported "I can't sign in". Prod held **no user row** for them and the only
trace was three `GET /auth/callback → 400`. Nothing in the audit log, nothing at warn or
error. The sharing settings of the canvas they were sent were fine and irrelevant — they
never got a session at all.

## Root cause

`completeLogin`'s domain/allowlist rejection (`email_domain_not_allowed`) returned the
friendly 400 page and recorded **nothing**: no `auth_denied` row, no log line. The auth
*gateway* had recorded `auth_denied / domain_not_allowed` since U7, but the OIDC callback
seam — where an interactive login actually fails — never did. So the single most common
real-world sign-in failure (wrong Google account / not-yet-allowed domain) was the one
failure the logs could not explain.

Fixed in #80: every rejection in the callback + `completeLogin` now records `auth_denied`
with its reason code (`missing_oidc_state`, `state_mismatch`, `token_exchange_failed`,
`no_email_claim`, `email_not_verified`, `email_domain_not_allowed`, `blocked`) plus a warn
line, folded into `recoverableAuthError` so a future denial path can't forget to.

## The diagnosis technique (still useful when a log line is missing)

**Callback duration tells you how far the flow got.** The pre-exchange guards return
without any network call (~0–1 ms); anything past them has done a token exchange with the
IdP (~110–190 ms on this box — compare against a *successful* login the same day).
So a 155 ms 400 means Google accepted the user and *we* rejected them.

Then eliminate by log level: `token_exchange_failed` logs at error, `no_email_claim` and
`email_not_verified` at warn. Zero warn/error lines all day ⇒ none of those ⇒ the silent
domain rejection. (`journalctl -u canvas-drop -o cat | grep -E '"level":(40|50|60)'`.)

## Two settings, not one — the trap when onboarding a new email domain

- `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` gates **sign-in**.
- `CANVAS_DROP_ORG_DOMAINS` gates **org membership** (derived live per request from the
  verified email domain in `auth/org-membership.ts`).

Setting only the first lets someone log in as a **guest with no org** — and `whole_org`
denies non-members, so they still get an opaque 404 on every org canvas and it looks like
a sharing bug. Both are CSV lists; `ensureOrg` treats the configured set as authoritative
(adds new domains, prunes removed ones) at boot, so adding a domain is an env edit plus a
service restart. `allowed_emails` (the admin table) likewise grants sign-in only, never
membership.

# Sharing & access

Control who can open a canvas from its **Share** tab. Every canvas is
**private by default** — only you, its owner, can open it. To let others in, pick
one **access rung**, then optionally layer a password or an expiry on top.

> Admins don't get a back door into your content. For a canvas they don't own, an
> admin is treated like any other org member: a private canvas returns a 404, a
> password prompts them too, and they can't open the editor or change its
> settings. An admin's cross-owner power is moderation only — see it in the
> all-canvases list and disable / re-enable / restore it.

## The access ladder

One rung per canvas, stored as the `access` field (default `private`):

| Rung | Who can open it | Backend primitives |
| --- | --- | --- |
| **Private** | Only you, the owner. | Full, for the owner. |
| **Specific people** | A named allowlist — org members *and/or* outside guests you invite by email. | Members & guests: KV, files, realtime. AI: off for guests unless you opt in. |
| **Whole org** | Any signed-in org member with the link. | Full, for org members. |
| **Public link** | Anyone with the link (no sign-in). Granted per account by an admin. | **None** — static files only. |

Password and expiry are modifiers you can add on top of any rung. The slug in each
canvas URL is defense-in-depth, not a substitute for a rung — and only when it's the
default **random** slug (`quiet-otter-x7k2…`). If you give a canvas a **custom slug**
(e.g. `team-dashboard`), the URL is human-guessable, so the rung is doing all the work:
the dashboard shows a reminder when a canvas is both link-reachable (Whole org / Public
link) and using a custom slug.

## Inviting specific people

Choose **Specific people**, then add by email:

- An **org member's** email goes straight onto the allowlist — they open the
  canvas with their normal sign-in. Matched by user id.
- An **outside email** becomes an **invited guest**: the app emails them a
  single-use magic sign-in link. Clicking it opens a confirm page; a same-origin
  POST consumes the token and establishes a **guest session scoped to that one
  canvas** — guests can never reach your other canvases. Matched by email. Each
  guest shows in the People list as pending or active, with **Resend** and
  **Remove**.

Guests get **KV, files, and realtime**. **AI is off for guests** unless you turn
it on for the canvas (the *Guest permissions* section), and when you do you set a
**USD spend cap** — AI is the metered-cost primitive, so it's opt-in and bounded.

A guest is never prompted for the canvas password; their magic link is the gate.
Owners are never prompted either. Other non-owners are prompted when a password
is set.

> Email-invited guests work when the app manages sign-in (`oidc` / `dev` modes).
> Behind an identity-aware proxy (`proxy` mode), the proxy owns the sign-in
> boundary, so guest invites depend on your operator's setup.

## Password & expiry

- **Password** (the *Locks* section): set a password and non-owners are prompted
  before the canvas opens (argon2id-hashed, scoped cookie). Owners and invited
  guests are never prompted.
- **Share expiry**: set a timestamp and access auto-revokes when it passes. You
  see a countdown, then an expired state.

A canvas with a password cannot be listed in the gallery.

## Public links

**Public link** lets anyone with the URL view a canvas with no sign-in — but it's
**static-only**: the page and its files serve, while every backend primitive (KV,
files, AI, realtime) is refused, so the open internet can never touch your org's
spend or stored data. It's a guarded capability: an **admin grants it per
account**, and the rung only appears in your Share tab once you've been granted
it. For everyone except the owner, a public-link canvas is always static-only.

## Listing in the gallery

The Share tab also has an opt-in **gallery** listing (summary, tags, and an
optional *use as template* toggle). A canvas can only be listed when it has a
shared access rung, a published version, and **no password** set.

## Revoking

Access is always revocable and never cached. Lowering the rung, removing an
allowlist entry, revoking a guest invite, hitting an expiry, regenerating the
slug, or unpublishing the canvas takes effect on the **next request** and drops
live realtime sockets — no stale grants. A guest session never outlives its
invite's expiry or revocation. Re-publishing a canvas does **not** silently
restore old guest grants; invite people again deliberately.

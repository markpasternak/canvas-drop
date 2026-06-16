# Sharing & access

Every canvas is **private by default** — only you, its owner, can open it. When
you're ready to let others in, you pick one **access rung** in **Settings →
Sharing**. Sharing a canvas requires it to be published.

> Admins don't get a back door into your content. For a canvas they don't own an
> admin is treated like any other org member: a private or unlisted one returns a
> 404, a password prompts them too, and they can't open the editor or change its
> settings. An admin's cross-owner power is moderation only — see it in the
> all-canvases list and disable / re-enable / restore it.

## The access ladder

| Rung | Who can open it | Backend primitives |
| --- | --- | --- |
| **Private** | Only you, the owner. | — (owner has full access) |
| **Specific people** | A named allowlist — org members *and/or* outside guests you invite by email. | Members & guests: KV, files, realtime. AI: off for guests unless you opt in. |
| **Whole org** | Anyone in your org with the link. | Full, for org members. |
| **Public link** | Anyone with the link (no sign-in). Admin-granted per account. | **None** — static files only. |

Password and expiry are modifiers you can layer on top (the **Public link** and
**Whole org** rungs honor a password; an invited guest's magic link is itself the
gate, so they're never prompted).

## Inviting specific people

Choose **Specific people**, then add by email:

- An **org member's** email is added straight to the allowlist — they open the
  canvas with their normal sign-in.
- An **outside email** becomes an **invited guest**: we email them a one-time
  magic sign-in link. Clicking it gives them a lightweight guest session scoped to
  **only that canvas** — they can never reach your other canvases. You'll see each
  guest as a named entry (pending / active) with **Resend** and **Remove**.

Removing someone — or lowering the rung — cuts their access on their next request
and drops any live realtime connection. Guests get **KV, files, and realtime**;
**AI is off for guests** unless you turn on *“Let invited guests use AI”* for that
canvas (AI is the metered-cost primitive, so it's opt-in).

> Email-invited guests and public links work when the app manages sign-in
> (`oidc`/`dev` modes). Behind an identity-aware proxy (`proxy` mode), the proxy
> owns the boundary, so these options are unavailable unless your operator carves
> out a path for them.

## Public links

**Public link** lets anyone with the URL view a canvas with no sign-in — but it's
**static-only**: the page and its files serve, while every backend primitive (KV,
files, AI, realtime) is refused, so the open internet can never touch your org's
spend or stored data. It's a guarded capability: an **admin grants it per
account** (Admin → Users → *Grant public*), and the rung only appears in your
settings once you've been granted it. Revoking the grant returns your public
canvases to private immediately.

## Revoking

Access is always revocable and never cached: lowering the rung, removing an
allowlist entry, revoking a guest, hitting an expiry, or unpublishing the canvas
takes effect on the **next request** and drops live sockets. Re-publishing a
canvas does **not** silently restore old guest grants — invite people again
deliberately.

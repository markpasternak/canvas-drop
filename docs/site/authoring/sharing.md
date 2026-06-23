# Sharing & access

Control who can open a canvas from its **Share** tab. Every canvas is
**private by default** — only you, its owner, can open it. To let others in, pick
one **access rung**, then optionally layer a password or an expiry on top.

**Publish first.** A canvas must have a published version before you can raise it
above Private. If you try to share an unpublished canvas the server refuses with
`SHARE_REQUIRES_PUBLISH` (409). Publish from the Editor or Versions tab, then set
the rung.

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
| **Specific people** | A named allowlist — signed-in users plus pending emails that activate after verified sign-in. | Full, for authenticated people on the allowlist. |
| **Team** | Members of the [teams](/docs/authoring/teams) you grant — a personal team (friends & family) or a subset of your org. | Full, for team members. |
| **Whole org** | Any signed-in org member with the link. | Full, for org members. |
| **Public link** | Anyone with the link (no sign-in), while the instance switch is on and the owner has not been revoked. | **None** — static files only. |

> **When an org boundary is configured** (the operator named an org — off by
> default), **Whole org** means *members of this canvas's home org*, not "anyone
> signed in." Members pick **Personal** or the workspace when they create a canvas
> (a [fixed choice](/docs/authoring/create-and-publish#personal-vs-workspace)); a
> Personal canvas can't be shared org-wide, and brought-in **external people** (people on a
> non-org domain) never see Whole-org canvases — only the specific ones they're
> added to. With no org configured, Whole org is simply "any signed-in user."

Password and expiry are modifiers you can add on top of any rung. The slug in each
canvas URL is defense-in-depth, not a substitute for a rung — and only when it's the
default **random** slug (`quiet-otter-x7k2…`). If you give a canvas a **custom slug**
(e.g. `team-dashboard`), the URL is human-guessable, so the rung is doing all the work:
the dashboard shows a reminder when a canvas is both link-reachable (Whole org / Public
link) and using a custom slug.

## Adding specific people

Choose **Specific people**, then add by email. The result is deterministic:

- An **existing signed-in user** is granted immediately. They open the canvas with
  their normal sign-in and appear as active in the People list.
- A **new email that your auth setup can admit** becomes a **pending sign-in grant**.
  It has no login power by itself. It turns into real access only after that exact
  email signs in through your configured auth (`oidc`, `proxy`, or `dev`).
- A **brand-new external email** is refused unless policy allows it. Admins can add
  external people from **Admin -> People**. A non-admin member can add one only when
  the operator enables `invites.allowMemberNewEmails`, or when the email can already
  authenticate through an allowed domain or an existing sign-in permit.

Pending people are visible in the People list and can be removed before they ever
sign in. Removing an active or pending person takes effect on the next request.

The People list has one **Add person** action. It grants access immediately when it can,
or records pending access for an email that must sign in first. When outbound email is
enabled, the person gets a courtesy sign-in/access email. The action can return
`granted`, `pending`, `already_added`, `already_pending`, or a policy/error state such as
`NOT_PERMITTED` or `RATE_LIMITED`. There is no app-owned password or magic-link account;
the person authenticates the same way everyone else does.

> In `proxy` mode the upstream IAP owns admission. canvas-drop can record grants for
> existing or already-admitted people, but it cannot make a brand-new external email
> reachable by itself. Add that person to the upstream access policy or use
> **Admin -> People** for app-managed admission where applicable.

## Sharing with a team

Choose **Team** to share with one or more [teams](/docs/authoring/teams)
— named groups you create. A team can be **personal** (friends & family — anyone you add
by email) or **org-attached** (a subset of your org). The share control lists only the teams
**you belong to**; pick one or more, and every member can open and use the canvas (full
backend, like a member). A team grant is independent of your own membership afterward — if
you later leave the team, the canvas stays shared with it until you change the rung.

Team canvases are **strictly team-scoped**: they never appear in the org-wide gallery.
Members reach them through **Teams → Shared with your teams** in the dashboard (or
`list_shared_with_teams` over [MCP](/docs/agents/mcp)). For an **org** team, membership is
re-checked on every request against your *live* org membership, so someone removed from the
org loses access immediately, even if a stale team row lingers. For a **personal** team,
direct membership is the boundary.

> Unlike **Whole org**, the **Team** rung does **not** require an org workspace: any
> signed-in user can create a personal team and share even a
> [Personal](/docs/authoring/create-and-publish#personal-vs-workspace) canvas with it. You
> manage teams — create, add people, leave — on the **Teams** page.

## Password & expiry

- **Password** (the *Locks* section): set a password and non-owners are prompted
  before the canvas opens (argon2id-hashed, scoped cookie). Owners are never prompted.
- **Share expiry**: set a timestamp and access auto-revokes when it passes. You
  see a countdown, then an expired state.

A canvas with a password cannot be listed in the gallery.

## Public links

**Public link** lets anyone with the URL view a canvas with no sign-in — but it's
**static-only**: the page and its files serve, while every backend primitive (KV,
files, AI, realtime) is refused for public visitors, so the open internet can
never touch your org's spend or stored data. It's governed at two levels:
**public links are available by default while the instance switch is on**, and an
admin can revoke the publish-public capability for a specific account. For
everyone except the owner, a public-link canvas is always static-only.

## Tags

Every canvas has one set of **tags** — short labels you add on the canvas detail
page (Enter or comma confirms each; tags are trimmed and lowercased). They serve
double duty: in **Your canvases** they power the tag filter so you can narrow a
large library, and once a canvas is **listed in the gallery** the same tags show
publicly and drive the gallery's tag shortcuts. There is one tag set per canvas —
not a separate "gallery tags" — so a tag you add for your own filtering is the
same tag your colleagues see when the canvas is listed. The limit is **20 tags,
up to 50 characters each**. Agents set the same field with `update_canvas` (the
`tags` parameter) over MCP.

## Listing in the gallery

The Share tab also has an opt-in **gallery** listing (the canvas's **description**,
its **tags**, and an optional *use as template* toggle). A canvas can only be listed
when it has a shared access rung, a published version, and **no password** set. The
**description** is a single field (max 2000 characters) used everywhere the canvas is
shown — the Overview tab, the gallery, and grid cards — there is no separate "gallery
summary". Agents set it with `update_canvas` (the `description` parameter).

## Finding canvases (search)

Both **Your canvases** and the **gallery** share one forgiving search. A query
matches across a canvas's **title, description, tags, and slug**, and matching is
**case-, accent-, and whitespace-insensitive** — `café`, `Cafe`, and `caf` all find
"Café Menu". A multi-word query is AND-matched: every word must appear somewhere
in those fields (the words can live in different fields — e.g. a word in the
title and another in a tag). The same forgiving search backs the MCP
`list_canvases` `query` filter; that tool also takes a `tags` filter that matches
any canvas carrying any of the given tags.

## When an admin disables a canvas

An admin can take a canvas down for moderation (the *disable* action in the
all-canvases list). A disabled canvas becomes **read-only to its owner**: every
owner mutation — settings, sharing, tags, capabilities, slug, preview, deploy /
publish / rollback, archive / unpublish, and draft edits — is refused with a
`DISABLED` error (HTTP 409 over the management API, a `DISABLED: …` failure over
MCP). Reads still work, so you can still open the canvas, see its versions and
usage, and read the **takedown reason** the admin left. An admin can re-enable or
restore it; you cannot delete a disabled canvas while it's down.

## Revoking

Access is always revocable and never cached. Lowering the rung, removing an
allowlist or pending entry, hitting an expiry, regenerating the slug, or
unpublishing the canvas takes effect on the **next request** and drops live
realtime sockets — no stale grants. Legacy guest rows retained from older
deployments are revocation-only migration data; re-publishing a canvas does **not**
silently restore old grants.

# Sharing & access

Control who can open a canvas from its **Share** tab. Every canvas is
**private by default** — only you, its owner, can open it. To let others in, pick
one **access rung**, then optionally layer a password or an expiry on top. To let
someone *run* the canvas with you, make them an **editor** on the People list
(see [Roles](#roles-viewers-and-editors) below).

**Publish first.** A canvas must have a published version before you can raise it
above Private. If you try to share an unpublished canvas the server refuses with
`SHARE_REQUIRES_PUBLISH` (409). Publish from the Editor or Versions tab, then set
the rung.

> Admins don't get a back door into your content. For a canvas they don't own, an
> admin is treated like any other org member: a private canvas returns a 404, a
> password prompts them too, and they can't open the editor or change its
> settings. An admin's cross-owner power is moderation and offboarding only — see it
> in the all-canvases list, disable / re-enable / restore it, or reassign its owner
> when someone leaves.

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

## URL access vs discovery

Access and discovery are separate:

- The **access rung** decides who can open the URL.
- **List for people with access** decides whether a **Team** or **Whole org** share is
  discoverable in **Shared** for people who already have access.

When listing is off, the canvas is **link-only**: anyone covered by the rung can still open
the URL, but the canvas does not appear in Shared. This is the default for Team and Whole-org
shares, matching the "restricted but open with the link" model. Explicitly adding a Whole-org
canvas to the gallery turns listing on as part of that same action.

When listing is on:

- **Team** canvases appear in **Shared** for members of the granted teams. They still never
  appear in the gallery.
- **Whole org** canvases appear in **Shared** for members of the canvas's home org. They can
  also be added to that org's gallery; the gallery action supplies this listing opt-in.

**Specific people** shares are already addressed to named people, so active direct grants
appear in those people's Shared view without a separate listing switch. **Public link**
canvases do not appear in Shared; use the gallery for intentional public/org-wide discovery.

## Roles: viewers and editors

Every entry on a canvas's **People with access** list — a person, a pending
invitee, or a whole team — is either a **viewer** or an **editor**.

![The People with access list: the owner pinned first, then people and teams, each with a role control, and the Transfer ownership action](assets/tour-people.webp)

- A **viewer** can open the canvas whatever the general-access rung says (a viewer row
  is what the *Specific people* rung reads). Nothing else.
- An **editor** can do everything the owner can *on that canvas*: edit the draft,
  publish, roll back, restore, change settings and sharing, add and remove people
  (including other editors), regenerate the deploy key, and use the deploy and
  authoring APIs. Editors see the canvas in their own **Your canvases** list, marked
  with the owner (**editor · <owner>** on the card, *owned by <owner> · editor* on
  the row), and can narrow the list with the **Owned by me** / **Editing** filters.
- **Owner-only acts** stay with the owner: **deleting** the canvas, **transferring**
  ownership, and the retained guest-AI opt-in. An editor who tries one is told it is
  owner-only (`OWNER_ONLY`, HTTP 403); nothing changes.
- **Only org members and teams can be editors.** A guest (someone outside your org
  domains) is always a viewer, and a pending invite can only carry the editor role
  when its email belongs to an org domain. When an org boundary is configured, an
  editor grant is effective only while the person is *currently* a member of the
  org — checked on every request, so someone who leaves the org loses edit access
  on their next request and their live editor session and realtime sockets are
  dropped. Removing or demoting an editor takes effect the same way; if the general
  access rung still admits them, the canvas moves to **Shared** as view-only.
- **Entitlements follow the owner.** An editor can switch on the **Public link** only
  when the *owner's* account may publish publicly; usage and spend stay attributed to
  the canvas and its owner.

Pick the role when you add someone (**Viewer** is the default) and change it any
time from the row's role control. Promoting someone to editor sends them the
courtesy email; when an editor makes someone else an editor, the owner is told too.
After you remove or demote an editor, the dashboard offers to **regenerate the
deploy key** — a key they copied keeps working until you do.

### Two editors, one file

There is no real-time co-editing. Every draft save carries the hash of the file the
editor loaded; if someone else saved that file first, the save is refused
(`DRAFT_CONFLICT`, HTTP 409) naming who saved and when, and the editor keeps their
unsaved text next to the other person's version to compare and choose. Edits to
*different* files never conflict. Publish records who created each version, so the
**Versions** tab shows authorship.

### Transfer ownership

The owner can hand the canvas to any **editor who is an org member** (not to a team)
from the People section. It applies at once and is audited: the recipient becomes the
owner, you stay on as an editor, sharing and the public-link entitlement are
re-evaluated against the new owner's account, and the deploy key keeps working (the
new owner can rotate it). When an owner leaves the org, an admin can **reassign** any
of their canvases to another member from **Admin → Canvases**, with a reason; the
previous owner stays an editor when their account is still active, and the deploy
key is rotated.

## Adding specific people

Choose **Specific people**, then add by email — as a **viewer** or an **editor**
(editors keep access whatever rung you pick). The result is deterministic:

- An **existing signed-in user** is granted immediately. They open the canvas with
  their normal sign-in and appear as active in the People list.
- A **new email that your auth setup can admit** becomes a **pending sign-in grant**.
  It has no login power by itself. It turns into real access only after that exact
  email signs in through your configured auth (`oidc`, `proxy`, or `dev`).
- A **brand-new external email** is refused unless policy allows it. Admins can add
  external people from **Admin -> People**. A non-admin member can add one only when
  the operator enables `invites.allowMemberNewEmails`, or when the email can already
  authenticate through an allowed domain or an existing sign-in permit.

Pending people are visible in the People list, carry the role you gave them, and can
be re-roled or removed before they ever sign in. Removing an active or pending
person takes effect on the next request.

The People list has one **Add person** action. It grants access immediately when it can,
or records pending access for an email that must sign in first. When outbound email is
enabled, the person gets a courtesy sign-in/access email. The action can return
`granted`, `pending`, `already_added`, `already_pending`, `role_changed` (you passed a
role for someone already listed; an omitted role never changes an existing entry), or a
policy/error state such as `NOT_PERMITTED`, `GUEST_VIEWER_ONLY` (editor requested for a
guest email), or `RATE_LIMITED`. There is no app-owned password or magic-link account;
the person authenticates the same way everyone else does.

> In `proxy` mode the upstream IAP owns admission. canvas-drop can record grants for
> existing or already-admitted people, but it cannot make a brand-new external email
> reachable by itself. Add that person to the upstream access policy or use
> **Admin -> People** for app-managed admission where applicable.

## Sharing with a team

A team can be granted in two ways. On the **People** list, add a team as **viewers**
(honoured on the Team rung) or as **editors** (every current member edits, at any
rung — people who join the team later are editors too, and a member who leaves the
team stops being one). Below, the general-access **Team** rung shares the canvas
view-only with one or more [teams](/docs/authoring/teams) — named groups you create. A team can be **personal** (friends & family — anyone you add
by email) or **org-attached** (a subset of your org). The share control lists only the teams
**you belong to**; pick one or more, and every member can open and use the canvas (full
backend, like a member). A team grant is independent of your own membership afterward — if
you later leave the team, the canvas stays shared with it until you change the rung.

Team canvases are **strictly team-scoped**: they never appear in the org-wide gallery.
By default they are link-only. Turn on **List for people with access** if team members
should be able to find them under **Shared** in the dashboard (or through
`list_shared_canvases` over [MCP](/docs/agents/mcp)). For an **org** team, membership is
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
its **tags**, and an optional *use as template* toggle). Enabling it for **Whole org**
also turns on **List for people with access**, so one owner action makes the canvas
discoverable in Shared and in the organization-scoped gallery. A canvas can only be
listed when it is published, has **no password** set, and is either:

- **Public link**, or
- **Whole org**; gallery listing automatically enables organization discovery.

Team, Specific-people, and Whole-org canvases that have not been explicitly gallery-listed
never appear there. Whole-org entries are returned only to authenticated members of the
canvas's home org; Public-link entries remain discoverable to signed-in gallery viewers.
The **description** is a single field (max 2000 characters) used everywhere the canvas is
shown — the Overview tab, the gallery, Shared, and grid cards — there is no separate
"gallery summary". Agents set it with `update_canvas` (the `description` parameter).

## Finding canvases (search)

**Your canvases**, **Shared**, and the **gallery** share one forgiving search. A query
matches across a canvas's **title, description, tags, and slug**; Shared also matches
the owner name and access context such as team name. Matching is
**case-, accent-, and whitespace-insensitive** — `café`, `Cafe`, and `caf` all find
"Café Menu". A multi-word query is AND-matched: every word must appear somewhere
in those fields (the words can live in different fields — e.g. a word in the
title and another in a tag). The same forgiving search backs the MCP `list_canvases`
and `list_shared_canvases` `query` filters; `list_canvases` also takes a `tags`
filter that matches any owned canvas carrying any of the given tags.

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

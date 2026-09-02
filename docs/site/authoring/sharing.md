# Sharing & access

Decide who can open a canvas, who can edit it with you, and where it shows up. Everything on this page lives on the canvas's **Share** tab; agents reach the same controls over [MCP](#over-mcp).

Every canvas starts **private**: only you, the owner, can open it. Sharing is one choice plus optional layers:

1. Pick one **access rung**: Private, Specific people, Team, Whole org, or Public link.
2. Add named people or teams as **viewers** or **editors** under **People with access**.
3. Optionally add a **password** or a **share expiry** under **Locks**.
4. Optionally opt into discovery: **List for people with access** (the Shared page) or **List in the gallery**.

## Share with one colleague

1. Publish the canvas if you have not yet. The Share tab shows a single locked panel with a Publish button until the canvas has a live version.
2. Open **Share**, type their email under **People with access**, pick **Viewer** or **Editor**, and confirm.
3. Set the rung to **Specific people**. Viewers are admitted only at a rung that reads the list; editors are admitted at every rung.

An existing user can open the canvas on their next request. Over MCP the same two steps are:

```text
grant_access   { "id": "<canvas id>", "email": "someone@example.com", "role": "viewer" }
update_canvas  { "id": "<canvas id>", "access": "specific_people" }
```

**Publish first.** A request that raises the rung above Private on an unpublished or archived canvas is refused with `SHARE_REQUIRES_PUBLISH` (HTTP 409).

> Admins have no back door into your content. For a canvas they do not own, an admin is an ordinary member: a private canvas returns 404, a password prompts them too, and they cannot open the editor or change settings. Cross-owner admin power is moderation and offboarding only: the all-canvases list, disable / re-enable / restore, and reassigning the owner when someone leaves.

## The access ladder

One rung per canvas, stored as `access` (default `private`):

| Rung | Who can open it | Backend primitives |
| --- | --- | --- |
| **Private** | The owner and any editors. | Full. |
| **Specific people** | The viewers on the People list: signed-in users, plus pending emails that activate after a verified sign-in. | Full, for the people admitted. |
| **Team** | Members of the teams added to the People list as viewers. A team can be personal or org-attached; see [teams](/docs/authoring/teams). | Full, for team members. |
| **Whole org** | Any signed-in member with the link. | Full, for members. |
| **Public link** | Anyone with the URL, no sign-in, while the instance switch is on and the owner's account may publish publicly. | **None**: static files only. |

Editors are admitted at every rung, never see the password prompt, and are unaffected by expiry. Everyone else is evaluated per request, with nothing cached: a change to the rung, the list, or the locks applies on the very next request. Anyone with no route in gets an opaque **404**, never a "forbidden" that confirms the canvas exists.

**When an org boundary is configured** (the operator set `CANVAS_DROP_ORG_NAME`; off by default), **Whole org** means *members of this canvas's home org*, not "anyone signed in". Members pick **Personal** or the workspace when they create a canvas (a [fixed choice](/docs/authoring/create-and-publish#personal-vs-workspace)); a Personal canvas cannot be shared org-wide (the rung is shown disabled, and the server refuses with `ORG_REQUIRED`, HTTP 409), and a **guest** (a signed-in user in no org) never sees Whole-org canvases, only the specific ones they are added to. With no org configured, Whole org is "any signed-in user".

Which rungs you see depends on your account: **Whole org** is hidden for guests, **Team** appears when you belong to a team or an org, and **Public link** appears only while your own account may publish publicly.

### Slugs are not a rung

The random slug in a canvas URL (`quiet-otter-x7k2…`) is defense in depth, not access control. A **custom slug** (`team-dashboard`) is guessable, so the rung does all the work; the Share tab shows a heads-up when a canvas is link-reachable (Whole org or Public link) and uses a custom slug.

## Access vs discovery

Access and discovery are separate settings:

- The **access rung** decides who can open the URL.
- **List for people with access** (`discoverability`: `link_only` or `listed`) decides whether a **Team** or **Whole org** share appears on the **Shared** page for people who can already open it.

Team and Whole-org shares default to **link-only**: anyone the rung admits can open the URL, but the canvas is not listed. Turn listing on and:

- **Team** canvases appear in **Shared** for members of the viewer teams. They never appear in the gallery.
- **Whole org** canvases appear in **Shared** for members of the home org, and become eligible for the gallery. Listing a Whole-org canvas in the gallery turns this switch on as part of the same action; turning it off again also removes the canvas from the gallery.

**Specific people** shares are addressed to named people, so active direct grants appear in those people's Shared view without a listing switch. **Public link** canvases never appear in Shared; use the gallery for deliberate discovery.

## Roles: viewers and editors

Every entry under **People with access**, whether a person, a pending email, or a team, is a **viewer** or an **editor**. The owner is pinned first and has no role control.

![The People with access list: the owner pinned first, then people and teams, each with a role control, and the Transfer ownership action](/docs/assets/tour-people.webp)

| | Viewer | Editor |
| --- | --- | --- |
| Open the canvas | When the rung admits them (a viewer row is what *Specific people* reads; a viewer team is what *Team* reads). | At every rung, no password prompt, no expiry. |
| Edit the draft, publish, roll back, restore | No | Yes |
| Change settings and sharing, add or remove people (other editors included) | No | Yes |
| Regenerate the deploy key; use the deploy and authoring APIs | No | Yes |
| Delete, transfer ownership, guest-AI opt-in | No | No: **owner only** (`OWNER_ONLY`, HTTP 403) |

Editors see the canvas in **Your canvases**, marked `editor · <owner>` on a card and `owned by <owner> · editor` on a row, and can filter with **Owned by me** / **Editing**. Edited canvases do not appear in Shared.

- **Only org members and teams can be editors.** A guest (someone outside your org domains) is always a viewer (`GUEST_VIEWER_ONLY`, HTTP 400), and a pending email can carry the editor role only when it belongs to an org domain. When an org boundary is configured, an editor grant holds only while the person is *currently* a member, checked on every request: someone who leaves the org loses edit access on their next request, and their editor session and realtime sockets are dropped. Removing or demoting an editor works the same way; if the rung still admits them, the canvas moves to **Shared** as view-only.
- **Entitlements follow the owner.** An editor can switch on **Public link** only when the *owner's* account may publish publicly (`PUBLIC_LINK_OWNER_GATED`, HTTP 403, otherwise). Usage and AI spend stay attributed to the canvas and its owner.

Pick the role when you add someone (**Viewer** is the default) and change it any time from the row. A person promoted to editor gets a courtesy email when outbound email is on; when an editor makes someone else an editor, the owner is notified too. After you remove or demote an editor, the dashboard offers to **regenerate the deploy key**: a key they copied keeps working until you do.

### Two editors, one file

There is no real-time co-editing. Each draft save carries the hash of the file the editor loaded; if someone else saved that file first, the save is refused with `DRAFT_CONFLICT` (HTTP 409) carrying `path`, `currentHash`, `updatedBy`, `updatedByName`, and `updatedAt`. The editor keeps your unsaved text next to the other version so you can use theirs or overwrite. Edits to *different* files never conflict. Each publish records who created the version, so the **Versions** tab shows authorship.

### Transfer ownership

The owner can hand the canvas to any current **editor who is an org member**, including a member of an editor team; never to a team itself, and never by email (the picker lists eligible people; anyone else is refused with `NOT_ELIGIBLE`, HTTP 409). The transfer applies at once and is audited:

- The recipient becomes the owner; you stay on as an editor while your account is active and still passes the org check.
- If the canvas was on **Public link** and the new owner's account cannot publish publicly, the rung is turned off (`publicLinkReverted`).
- The deploy key keeps working; the new owner can rotate it.

When an owner leaves, an admin can **reassign** any of their canvases to another member from **Admin → Canvases** with a recorded reason. The previous owner stays an editor when their account is still active, both parties are emailed, and the deploy key is rotated in the same step (the new owner issues a fresh one).

## Adding specific people

Under **People with access**, add by email as a **viewer** or an **editor**. The outcome is deterministic:

| Outcome | Meaning |
| --- | --- |
| `granted` | An existing signed-in user; they can open the canvas now. |
| `pending` | A new email your auth setup can admit. It has no login power by itself; access materializes after that exact email signs in through the configured auth (`oidc`, `proxy`, or `dev`). |
| `already_added` / `already_pending` | Nothing changed. |
| `role_changed` | You passed a role for someone already listed. An omitted role never changes an existing entry. |
| `NOT_PERMITTED` (403) | A brand-new external email that policy does not let you admit. |
| `AUTH_ADMISSION_REQUIRED` (403) | The identity provider must admit that email before canvas-drop can grant it. |
| `GUEST_VIEWER_ONLY` (400) | Editor requested for a guest email. |
| `BLOCKED` (403) | That account is blocked. |
| `RATE_LIMITED` (429) | Too many adds; the response carries a retry hint. |

Who may admit a **brand-new external email**: admins always can, from the Share tab or **Admin → People**. A non-admin member can only when the operator turns on **Let members add brand-new emails** (`invites.allowMemberNewEmails`, off by default), or when the email can already authenticate through an allowed domain or an existing sign-in permit.

Pending people show in the list with the role you gave them and can be re-roled or removed before they ever sign in. Removing an active or pending person takes effect on the next request. When outbound email is enabled (`CANVAS_DROP_EMAIL_DRIVER`), the person receives a courtesy sign-in or access email. There is no app-owned password or magic link; everyone authenticates the same way.

> In `proxy` mode the upstream identity-aware proxy owns admission. canvas-drop can record grants for people who already exist or are already admitted, but it cannot make a brand-new external email reachable on its own. Add that person to the upstream access policy first.

## Sharing with a team

A team can be granted two ways from **People with access**:

- As **viewers**: honoured on the **Team** rung. Set the rung to Team and members of every viewer team can open and use the canvas (full backend). The rung needs at least one viewer team on the list (`TEAM_REQUIRED`, HTTP 409, otherwise); with none, the Share tab points you to add one.
- As **editors**: every current member edits at any rung. People who join the team later are editors too; a member who leaves the team stops being one.

You can grant only teams you belong to, and an org team must match the canvas's org (`TEAM_FORBIDDEN`, HTTP 403, otherwise). The grant is independent of your own membership afterward: if you leave the team, the canvas stays shared with it until you change the list. For an **org** team, membership is re-checked against live org membership on every request, so someone removed from the org loses access immediately even if a stale team row lingers. For a **personal** team, direct membership is the boundary.

Team canvases are strictly team-scoped and never appear in the gallery. They are link-only by default; turn on **List for people with access** so members can find them under **Shared** (or through `list_shared_canvases` over MCP).

> Unlike **Whole org**, the **Team** rung does not need an org workspace: any signed-in user can create a personal team and share even a [Personal](/docs/authoring/create-and-publish#personal-vs-workspace) canvas with it. Manage teams on the **Teams** page.

## Password & expiry

Both live under **Locks** and apply on top of any rung:

- **Password**: non-owners who can open the canvas are prompted before it loads. The password is stored as an argon2id hash and cannot be shown again; **Generate** produces one you can copy. Owners and editors are never prompted; a non-owner admin is. A password has no effect while the canvas is Private.
- **Share expiry**: set a timestamp and access auto-revokes when it passes. The tab shows a countdown, then an expired notice; non-owners get a 404 until you clear or extend it.

A canvas with a password cannot be listed in the gallery; setting one on a listed canvas un-lists it, turns off its template setting, and clears its tags.

## Public links

**Public link** lets anyone with the URL view the canvas with no sign-in, **static-only**: the page and its files serve, while every backend primitive (KV, files, AI, realtime) is refused for public visitors, so the open internet never touches your org's spend or stored data. Signed-in members hitting a public-link canvas are static-only too; only the owner and editors get full content.

Two switches govern it:

- The instance-wide **Public links enabled** setting (`access.publicLinksEnabled`, on by default). Turning it off makes every existing public link stop working immediately, and new attempts fail with `PUBLIC_LINKS_DISABLED` (HTTP 403).
- The per-account **publish public** entitlement an admin can grant or revoke. Without it the owner gets `PUBLIC_NOT_ALLOWED`, and an editor acting on that owner's canvas gets `PUBLIC_LINK_OWNER_GATED` (both HTTP 403).

## AI for added people

Shown only on the **Specific people** rung, and owner-only: **Allow added people to use AI** (`guestAiEnabled`, off by default) plus a USD **spend cap** (`guestAiCap`). Added people can already use KV, files, and realtime when those capabilities are on; AI is metered and billed to the owner, so it is opt-in per canvas. An editor who touches these fields gets `OWNER_ONLY`.

## Gallery, description, and tags

**Gallery & templates** on the Share tab is an opt-in listing. A canvas can be listed only when it is published, has **no password**, and is either **Public link** or **Whole org** (listing a Whole-org canvas also turns on **List for people with access**). Team and Specific-people canvases never appear there. When an org boundary is configured, Whole-org entries are returned only to signed-in members of the canvas's home org; Public-link entries are visible to any signed-in gallery viewer. **Allow others to use as a template** lets colleagues clone the canvas as a starting point; your canvas is untouched.

The **description** is one field (max 2000 characters) used everywhere the canvas is shown: Overview, Shared, grid cards, and the gallery. There is no separate gallery summary.

**Tags** are one set per canvas, edited on the Overview tab (Enter or a comma confirms each; values are trimmed and lowercased; max **20 tags of up to 50 characters**). They power the tag filter in **Your canvases**, and once the canvas is gallery-listed the same tags show there and drive its tag shortcuts. Agents set both with `update_canvas` (`description`, `tags`).

## Finding canvases

**Your canvases**, **Shared**, and the **gallery** share one forgiving search over a canvas's **title, description, tags, and slug**; Shared also matches the owner's name and the access label (a team name, for example). Matching is case-, accent-, and whitespace-insensitive: `café`, `Cafe`, and `caf` all find "Café Menu". A multi-word query is AND-matched: every word must appear somewhere in those fields, in any combination. The same search backs the MCP `list_canvases` and `list_shared_canvases` `query` filters; `list_canvases` also takes a `tags` filter that matches any owned canvas carrying any of the given tags.

## When an admin disables a canvas

An admin can take a canvas down for moderation. A disabled canvas becomes **read-only to its owner and editors**: every mutation (settings, sharing, tags, capabilities, slug, preview, deploy / publish / rollback, archive / unpublish, draft edits) is refused with `DISABLED` (HTTP 409 over the management API, a `DISABLED: …` failure over MCP). Reads still work, so you can open the canvas, see its versions and usage, and read the takedown reason. You cannot delete a disabled canvas; an admin must re-enable or restore it first.

## Revoking

Access is always revocable and never cached. Lowering the rung, removing a person, pending email, or team, hitting an expiry, regenerating the slug, or unpublishing takes effect on the **next request** and drops live realtime sockets. Legacy guest rows kept from older deployments (`guest:<id>` entries) are revocation-only migration data; re-publishing a canvas does not restore old grants.

## Over MCP

Every control above has an MCP tool that wraps the same service and role gate (owner or editor; a canvas you hold no role on reads as not found):

| Tool | What it does |
| --- | --- |
| `list_access` | The people list with a `role` per entry and stable ids (`owner`, `member:<id>`, `guest:<id>`, `pending:<id>`, `team:<teamId>`); owners also get `transferCandidates`. |
| `grant_access` | Add a person (`email`) or team (`teamId`) with `role` `viewer` or `editor`; the silent add. |
| `invite_to_canvas` | The same add with a courtesy email. |
| `set_access_role` | Change one entry's role. |
| `revoke_access` | Remove an entry (the `owner` entry cannot be removed). |
| `search_people` | Eligible-people suggestions for a canvas or team you can see. |
| `update_canvas` | `access`, `discoverability`, `teamIds`, `password`, `sharedExpiresAt`, `guestAiEnabled`, `guestAiCap`, `galleryListed`, `galleryTemplatable`, `description`, `tags`. |
| `transfer_canvas` | Owner-only: hand the canvas to an existing editor by user id. |
| `list_shared_canvases` | The Shared view: canvases opened to you that you do not own or edit. |

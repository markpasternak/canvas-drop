# Teams

A **team** is a named group you share canvases with — the slice between "just me"
and "everyone." Share a canvas with a team from its **Share** tab, and every member
can open and use it (full backend, like a member). Manage teams on the **Teams**
page in the dashboard, or over [MCP](/docs/agents/mcp).

A team is one kind of entry on a canvas's **Share with people and teams** list, next to
individual people. Whatever is on that list can open the canvas at every **General access**
choice:

| General access | Who else can open it |
| --- | --- |
| **Restricted** | Nobody beyond the owner, the editors, and the people and teams on the list. |
| **Whole org** | Anyone signed in to your organization. |
| **Public link** | Anyone with the URL — static files only while the instance switch is on and the owner account has not been revoked. |

See [Sharing & access](/docs/authoring/sharing) for the full model and the
password / expiry modifiers.

## Personal vs org teams

The kind of team is a **fixed choice at creation**:

- **Personal** — friends & family. *Any* signed-in user can create one (no org
  required) and add people by email when policy allows it. Direct membership is the access boundary.
- **Org-attached** — a subset of your org. Only org members can create one, and
  members must belong to that org. Access is re-checked against your **live** org
  membership on every request, so someone removed from the org loses access at once
  — even if a stale membership row lingers.

Team names are **per-creator**: you can't make two teams with the same name, but
different people can each have a team named "Design."

## Creating a team and adding people

On the **Teams** page, pick **Personal** (or your org), name the team, and create
it — you're its first member and its manager. Then add people by email:

- An **existing user** joins immediately.
- A **brand-new person** (no account yet) becomes **Pending sign-in**. They
  turn into a full member the **first time they sign in** through your instance's
  configured auth — there's **no app-owned password and no magic-link account** to
  manage. Until they sign in, they show as *Pending* on the roster and simply can't
  open anything yet.

This is **auth-delegated**: the identity provider is the only authority, so there's
nothing to take over. See the
[security model](/docs/self-hosting/security-model#adds-are-auth-delegated-no-app-owned-credentials)
for the full picture.

> **Who may add a brand-new external email is gated.** A self-serve member can
> always add existing users and people on your org's domains, but adding a
> brand-new *external* email (one that can't already sign in) is **admin-only** unless
> the operator turns on `invites.allowMemberNewEmails`. Adds are also
> rate-limited per person. See
> [Sign-in permits & access emails](/docs/self-hosting/configuration#sign-in-permits--access-emails).

## The roster

Expanding a team shows its **members** plus any **pending sign-ins** (email-only
rows for people who haven't signed in yet). Remove a member at any time — including
a **pending** invite, so a typo'd email can be taken back without an admin — or
**leave** a team yourself (leaving asks you to confirm: you can't re-add yourself).
Canceling a pending invite removes the team access it would have granted; if the
add also newly admitted that address to sign in to the instance, an admin can
revoke the sign-in permit from the **People** directory. The team's creator (or an
admin) can rename or delete it — deleting a team removes its memberships and
unshares every canvas shared with it, but the canvases themselves are untouched.

## Sharing a canvas with a team

On a canvas's **Share** tab, under **Share with people and teams**, pick a team you belong
to and add it as **Viewer** (or **Editor**). The list labels each team **Personal** or by
its **org**, so you can see how far the share reaches. A team grant is independent of your
own membership afterward: if you later leave the team, the canvas stays shared with it
until you remove it from the list. Changing **General access** never touches it.

Members can open the canvas at once and find it under **Shared** in the dashboard (or
through `list_shared_canvases` over MCP) — there is no listing switch to turn on. A canvas
shared only with people and teams never appears in the org-wide gallery.

## Editor teams

A team can also be granted the **editor** role on a canvas, from the canvas's
**Share with people and teams** section (choose the team, pick **Editor**). Every current member
then manages that canvas like the owner — content, publishing, settings, sharing —
except deleting or transferring it; membership changes apply on the next request, and
for an org team the live org membership is re-checked as well. A team added as
**viewers** opens the canvas for its members at every General-access choice. See
[Roles: viewers and editors](/docs/authoring/sharing#roles-viewers-and-editors).

## Over MCP (agents)

Everything here is available to an agent over [MCP](/docs/agents/mcp), wrapping the
same service the dashboard uses: `create_team` (omit `orgId` for a personal team),
`add_team_member` (returns `granted` or `pending`), `cancel_team_invite` (take back
a pending invite by its roster `id`), `list_team_members` (members +
pending), `grant_access` (with `teamId` and a `role` of `viewer` or `editor`), `set_access_role`,
`revoke_access`, and `list_shared_canvases`. The legacy `update_canvas` fields `access: "team"`
(an alias of `private`) and `teamIds` (replace the viewer-team grants) are still accepted;
team members see a shared canvas in Shared without any `discoverability` setting.

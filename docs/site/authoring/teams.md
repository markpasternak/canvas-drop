# Teams

A **team** is a named group you share canvases with — the slice between "just me"
and "everyone." Share a canvas with a team from its **Share** tab, and every member
can open and use it (full backend, like a member). Manage teams on the **Teams**
page in the dashboard, or over [MCP](/docs/agents/mcp).

Teams sit on the middle rung of the per-canvas **access ladder**:

| Rung | Who can open it |
| --- | --- |
| **Private** | Just you, the owner. |
| **Specific people** | A named few you add or invite, by email. |
| **Team** | Members of the teams you grant — **a personal team, or a subset of your org.** |
| **Whole org** | Anyone signed in to your organization. |
| **Public link** | Anyone with the URL — admin-gated, and static files only. |

See [Sharing & access](/docs/authoring/sharing) for the full ladder and the
password / expiry modifiers.

## Personal vs org teams

The kind of team is a **fixed choice at creation**:

- **Personal** — friends & family. *Any* signed-in user can create one (no org
  required) and invite *anyone* by email. Direct membership is the access boundary.
- **Org-attached** — a subset of your org. Only org members can create one, and
  members must belong to that org. Access is re-checked against your **live** org
  membership on every request, so someone removed from the org loses access at once
  — even if a stale membership row lingers.

Team names are **per-creator**: you can't make two teams with the same name, but
different people can each have a team named "Design."

## Creating a team and inviting people

On the **Teams** page, pick **Personal** (or your org), name the team, and create
it — you're its first member and its manager. Then invite people by email:

- An **existing user** joins immediately.
- A **brand-new person** (no account yet) becomes a **Pending** invitation. They
  turn into a full member the **first time they sign in** through your instance's
  configured auth — there's **no app-owned password and no magic-link account** to
  manage. Until they sign in, they show as *Pending* on the roster and simply can't
  open anything yet.

This is **auth-delegated**: the identity provider is the only authority, so there's
nothing to take over. See the
[security model](/docs/self-hosting/security-model#invites-are-auth-delegated-no-app-owned-credentials)
for the full picture.

> **Who may invite a brand-new external email is gated.** A self-serve member can
> always invite existing users and people on your org's domains, but inviting a
> brand-new *external* email (one that can't already sign in) is **admin-only** unless
> the operator turns on `invites.allowMemberNewEmails`. Invites are also
> rate-limited per person. See
> [Add users & invites](/docs/self-hosting/configuration#add-users--invites).

## The roster

Expanding a team shows its **members** plus any **pending** invitations (email-only
rows for people who haven't signed in yet). Remove a member at any time, or **leave**
a team yourself. The team's creator (or an admin) can rename or delete it — deleting
a team removes its memberships and unshares every canvas shared with it, but the
canvases themselves are untouched.

## Sharing a canvas with a team

On a canvas's **Share** tab, choose the **Team** rung and pick one or more teams you
belong to. The picker labels each team **Personal** or by its **org**, so you can see
how far the share reaches. A team grant is independent of your own membership
afterward: if you later leave the team, the canvas stays shared with it until you
change the rung.

Team canvases are **strictly team-scoped** — they never appear in the org-wide
gallery. Members find them under **Teams → Shared with your teams** (or
`list_shared_with_teams` over MCP).

## Over MCP (agents)

Everything here is available to an agent over [MCP](/docs/agents/mcp), wrapping the
same service the dashboard uses: `create_team` (omit `orgId` for a personal team),
`add_team_member` (returns `granted` or `pending`), `list_team_members` (members +
pending), `invite_to_canvas`, and `update_canvas` with `access: "team"` + `teamIds`.

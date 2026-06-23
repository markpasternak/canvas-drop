# MCP server

canvas-drop exposes a remote **Model Context Protocol** endpoint so an MCP-capable
agent host (Claude, ChatGPT, …) can connect once and then create, deploy, and manage
the canvases you own — with no API key to paste. It is the identity-scoped companion
to the keyed [Deploy API](/docs/api/deploy-api): the Deploy API acts on one canvas
with its secret key; MCP acts across your whole account as *you*.

## Connect

Add the instance's MCP endpoint to your client:

```
{base}/mcp
```

On first use the client runs an OAuth 2.1 sign-in: it discovers the authorization
server (RFC 8414/9728 `.well-known` metadata), registers itself automatically
(Dynamic Client Registration), and opens a browser to **this instance's normal login**
(the same org sign-in you use for the dashboard). No second account, no secret to copy.
canvas-drop is its own authorization server — it does not proxy your IdP. In `oidc`
mode an unauthenticated agent is bounced through the usual login; in `proxy`/`dev`
mode identity is already resolved. The client stores the resulting access token (1h
TTL) and refreshes it automatically (refresh tokens rotate on use).

Identity always comes from that server-side sign-in — never from anything the client
asserts. The email-domain allowlist is enforced before any token is issued, and every
tool call re-checks that your account is still active, so a block or de-allowlist kills
a live token on the next request.

## Tools

Every tool is scoped to your account. A canvas you don't own reads as *not found* —
there is no cross-owner access and no existence leak.

| Tool | What it does |
|---|---|
| `whoami` | The connected account (`id`, `email`, `name`). When an org boundary is configured, also `orgs` (`[{id, name}]` you're a member of), `teams` (the teams you belong to), and `isGuest` (true = signed in but in no org) — use an org `id` as `create_canvas`'s `orgId`. |
| `list_canvases` | The canvases you own. Optional `query` filter — a forgiving text search over title, description, tags, and slug (case/accent/whitespace-insensitive; multiple words are AND-ed) — an optional `tags` filter (any-match — canvases carrying any of the given tags), plus `sort` (`updated` default, or `created`/`title`/`popular`), and `limit` (1–100, default 50). `sort=popular` ranks by trending views (last 30 days); every item carries `recentViews` (that 30-day count) plus lifetime `viewCount` and `lastViewedAt`. |
| `create_canvas` | Create a canvas; returns its id, URL, a one-time deploy key, and a `deploy` block of ready-to-run curl endpoints (so you never probe for the API host). Optional `orgId` homes it in an org you belong to (from `whoami.orgs`) so it can be shared org-wide; omit or `null` for a personal canvas. Only meaningful when an org boundary is configured. |
| `get_canvas` | Current state of a canvas you own (includes lifetime `viewCount` + `lastViewedAt`; full stats via `get_canvas_usage`). |
| `list_versions` | Version history of a canvas you own (`number`, `source`, `status`, `createdAt`, `fileCount`, `totalBytes`, `current`). |
| `deploy_canvas` | Publish static files directly to live in one call — pass either a base64-encoded ZIP (`zipBase64`) **or** a `files` array (text as UTF-8, binary as base64). |
| `begin_deploy` | Open a staged upload from a file manifest (path, sha256, size); returns an `uploadId` and the subset of hashes you still need to send. |
| `add_files` | Stage files into an open upload (text as UTF-8, binary as base64); call repeatedly to chunk a large set. |
| `finalize_deploy` | Publish a new version from a staged upload. Single-use. |
| `get_canvas_file` | Read back what's **live**: list the current version's files, or fetch one file's content. Use it to **verify a deploy** (the live URL is sign-in gated — see below). |
| `rollback_canvas` | Point a canvas back at an earlier `version` number (must be a ready version). |
| `unpublish_canvas` | Take a published canvas back to draft. |
| `set_capabilities` | Toggle a canvas's backend capabilities — `backendEnabled` is the master switch; `kv`/`files`/`ai`/`realtime` are individual features (effective only when backend is on). Omitted fields are unchanged. |
| `set_canvas_slug` | Change a canvas's URL slug (pass a custom one, or omit for a fresh random slug). The old URL stops working immediately. |
| `regenerate_deploy_key` | Mint a new `cd_…` deploy key and invalidate the old one; the new key is returned **once**. |
| `archive_canvas` | Archive a canvas (reversible) — takes its URL offline and revokes guest grants. |
| `unarchive_canvas` | Restore an archived canvas back to active. |
| `delete_canvas` | Soft-delete a canvas — it loses its URL and is purged after the retention window. Blocked if an admin has disabled the canvas. Not reversible from MCP. |
| `update_canvas` | Update settings/sharing (Settings + Share tabs): `title`, `description`, access rung (`private`/`specific_people`/`team`/`whole_org`/`public_link`), `password` (or null to clear), `sharedExpiresAt`, `spaFallback`, `previewMode` (`auto`/`off` — the cover toggle; upload a custom image with `set_canvas_preview`), gallery listing/metadata, `tags` (the canvas's unified tag set — owner-list filtering *and* public gallery display; max 20, 50 chars each), guest-AI. To share with teams, set `access: "team"` **and** `teamIds` (≥1 team you belong to in the canvas's org — see `list_teams`); switching off `team` clears the grants. Server enforces the preconditions (sharing/listing need a published canvas; `public_link` needs an admin grant; a password un-lists). |
| `set_canvas_preview` | Set or clear a canvas's custom cover image (the dashboard's preview upload). Pass `image` (base64 png/jpeg/webp) to pin it as the cover (`previewMode` becomes `custom`, so a publish never overwrites it); omit `image` to clear it back to `auto`. |
| `list_access` | List active named people plus pending sign-in grants for a canvas you own (each with an `id` for `revoke_access`; legacy guest rows can still appear during migration). |
| `grant_access` | Add a person by email. Existing users are granted now (`status: granted`); admissible new emails become pending auth-delegated grants (`status: pending`). No guest magic link is created. Takes effect on the `specific_people` rung. |
| `invite_to_canvas` | Deliberately invite a person by email (distinct from the quiet `grant_access`) — sends the courtesy email when email is enabled. It uses the same Add person service and statuses. A brand-new external email is refused for a non-admin (`NOT_PERMITTED`) unless the instance allows it; `RATE_LIMITED` past the cap. |
| `revoke_access` | Remove an active person, pending sign-in grant, or legacy guest row. Legacy guest sessions are revoked when present. |
| `clone_canvas` | Clone a canvas into a new one you own — any active canvas you own, or a gallery template someone shared. Starts as an unpublished draft with a fresh slug + key. |
| `get_canvas_usage` | Usage stats: views + 30-day sparkline, and (backend-on) KV/file/AI/realtime op counts, storage, AI tokens/cost. |
| `list_teams` | The teams you belong to, each with `mine` (you're a member) and `canManage` (you created it — so you can rename/delete it). |
| `create_team` | Create a team. **Omit `orgId`** for a *personal* team (friends & family — invite anyone); pass an `orgId` from `whoami.orgs` to attach it to that org. You become its first member and manager. |
| `rename_team` / `delete_team` | Rename or delete a team you created. Deleting unshares every canvas shared with it (the canvases are untouched). |
| `add_team_member` / `remove_team_member` | Add someone to a team you belong to by `email`, or remove a member (pass your own user id to leave). Returns `status`: `granted` (existing user joined now) or `pending` (a brand-new invitee — joins on first sign-in). For an org team they must be a same-org member; a brand-new external email on a personal team is refused for a non-admin unless the instance allows it. |
| `list_team_members` | The roster of a team you belong to (`userId`, `email`, `name`). |
| `list_shared_with_teams` | Canvases shared with one of your teams (the "shared with your teams" view) — strictly team-scoped, never in the gallery. Display-only; open via the returned `url`. |
| `get_draft` | The editor **draft** of a canvas you own — file list + state (`dirty` = differs from live). Creates it from the live version on first open. |
| `read_draft_file` | Read one draft file's content (text UTF-8 / binary base64). |
| `write_draft_file` | Write/replace a draft file (`create: true` refuses to overwrite). |
| `delete_draft_file` | Delete a draft file. |
| `rename_draft_file` | Rename/move a draft file. |
| `publish_draft` | Publish the draft as a new live version (the editor's Publish). |
| `restore_draft` | Reset the draft to a published `version`'s files (the editor's Restore). |

A typical session is `create_canvas` followed by `deploy_canvas` with your files — the
canvas is live in one round trip, and no per-canvas key is ever handled by the agent.

**If an admin has disabled a canvas** (a moderation takedown), it goes **read-only**:
the read tools (`get_canvas`, `list_versions`, `get_canvas_usage`, `get_draft`, …) keep
working, but every mutation tool — settings/sharing via `update_canvas`, capabilities,
slug, preview, access/guest tools, deploy / publish / rollback, archive / unpublish,
`delete_canvas`, and the draft-edit tools — fails with `DISABLED: <reason>` (the same
contract as the management API's `409 { code: "DISABLED" }`). The owner can still read
the canvas and the admin's takedown reason; only an admin can re-enable it.

**Every deploy publishes immediately.** There is no draft step over MCP: `deploy_canvas`
and `finalize_deploy` make the uploaded files the new **live** version at once (kept as
an immutable version you can roll back to). A new canvas starts **private** (owner-only);
its URL is **access-controlled** and serves content only to viewers allowed by the
canvas's share rung. So a freshly deployed canvas is live, but not an anonymous public URL
until you widen its access.

### Which deploy tool to use

`deploy_canvas` sends the whole payload in one call — use it for the **first
publish of a small canvas**. Prefer the staged flow (`begin_deploy` →
`add_files` → `finalize_deploy`) whenever the canvas **already has content (any
re-deploy)** or has **many / large / binary files**. The decision is simple and
reliable: *fresh tiny canvas → `deploy_canvas`; everything else → staged.*

The staged flow's win:

1. **`begin_deploy`** with the full manifest (`path`, `hash` = sha256 of the
   bytes, `size`). The server replies with `missingHashes` — the blobs it doesn't
   already have (content-addressed, so an unchanged file is **never re-sent**). A
   re-deploy that changed one file sends one file.
2. **`add_files`** the contents for those hashes, in as many calls as you like
   (chunk a large set; avoid one oversized tool call).
3. **`finalize_deploy`** to publish. The handle is single-use and short-lived; a
   finalize that's missing a blob fails cleanly and can be retried after staging it.

Over MCP, `add_files` content still travels in the tool call — the token win
comes from **not resending unchanged files** and from chunking.

**Strongly prefer `curl` over the keyed Deploy API for the file transfer.** Every
MCP deploy tool inlines file contents into the tool call (they pass through the
model). Whenever you can run shell commands, deploy with `curl` instead — and
**request command/network permission if you don't have it** rather than inlining
bytes. The same staged flow runs over plain HTTP on the keyed
[Deploy API](/docs/api/deploy-api): `POST …/uploads` with the manifest, then
`PUT …/uploads/{id}/blobs/{hash}` with each blob's **raw bytes**, then
`POST …/uploads/{id}/finalize`. The bytes go straight from disk to the server and
never enter the model context — far cheaper, with no payload-size ceiling.
`create_canvas` returns the per-canvas key you need. Reserve the MCP deploy tools
for a small first publish when shell access truly isn't available.

### Verify a deploy

The live URL is access-controlled, so **don't confirm a deploy by fetching it** — an
unauthenticated `GET` returns a login page, not your files. Verify through the server
instead:

- The deploy/finalize result already returns `{version, fileCount, totalBytes}`.
- `list_versions` shows the new version as `current`.
- **`get_canvas_file`** reads back what's actually live: call it with no `path` to list
  the live files (`path`, `size`, `mime`, `hash`), or with a `path` (e.g. `index.html`)
  to get that file's content (text as UTF-8, binary as base64; files over 256 KiB
  return their hash only — compare it to what you deployed).
- Over curl, the same read-back is `GET {apiBase}/files` (and `?path=` for raw bytes,
  no size cap) — `apiBase` comes from the `deploy` block `create_canvas` returned, so
  there's nothing to probe.

`create_canvas` (and `get_canvas`) return a `deploy` block with the **exact curl
endpoints** for the canvas — `apiBase`, `zipUpload`, the staged URLs, `readback`, and a
copy-paste `curl` command. `create_canvas` embeds the real key in that block (returned
**once**); `get_canvas` uses a `$CANVAS_KEY` placeholder instead — the key is never
re-handed-out, so set it from your own copy. In subdomain mode the API host
(`CANVAS_DROP_API_BASE_URL`, e.g. `api.example.com`) differs from the canvas host (it
falls back to `CANVAS_DROP_BASE_URL` when unset), so use these advertised endpoints
rather than guessing.

Tool calls are rate-limited per account (over the limit returns a `429` with
`Retry-After`) and recorded in the audit log alongside every other deploy and lifecycle
event.

## Enabling and disabling

The MCP surface is **on by default**. An operator can turn it off with one config flag
(`CANVAS_DROP_MCP=off`), which removes the `/mcp` endpoint and its OAuth routes
entirely — see [Configuration](/docs/self-hosting/configuration).

## Which path should an agent use?

- **MCP** — when your host speaks MCP and you want a connect-once, multi-canvas,
  identity-scoped surface.
- **[Deploy API](/docs/api/deploy-api)** (HTTP + per-canvas key) — for a keyed,
  sessionless agent or a CI step handed one canvas's key.
- The packaged **[Agent skill](/docs/agents/skill)** documents both for a coding agent,
  and **[`/llms.txt`](/llms.txt)** is the single-file quick reference.

# MCP server

Connect an MCP-capable agent host to a canvas-drop instance once, then create, deploy,
share, and edit canvases as the signed-in account. There is no per-canvas key to paste.
MCP is the identity-scoped companion to the keyed [Deploy API](/docs/api/deploy-api):
the Deploy API acts on one canvas with its secret key; MCP acts across every canvas you
own or edit, as you.

## Connect

Add the instance's endpoint to your MCP client:

```
{base}/mcp
```

The transport is Streamable HTTP and stateless: each request is authenticated on its
own, and there is no session to keep alive.

A first session, as tool calls:

```
whoami           {}
                 -> { id, email, name, orgs, teams, isGuest }
create_canvas    { "title": "Retro board" }
                 -> { id, slug, url, apiKey, deploy, ... }        apiKey is returned once
deploy_canvas    { "id": "<id>", "files": [{ "path": "index.html", "content": "<h1>Hi</h1>" }] }
                 -> { url, version: 1, fileCount: 1, totalBytes, warnings: [] }
get_canvas_file  { "id": "<id>", "path": "index.html" }
                 -> { version, path, size, mime, hash, encoding: "utf8", content }
```

The canvas is live after the third call. A new canvas starts on the `private` rung, so
its URL serves content only to you until you widen access with `update_canvas`.

### Sign-in (OAuth 2.1)

canvas-drop is its own OAuth 2.1 authorization server; it does not proxy your identity
provider. A compliant client needs nothing but the URL:

1. **Discovery.** `{base}/.well-known/oauth-authorization-server` and
   `{base}/.well-known/oauth-protected-resource` (RFC 8414 and RFC 9728). The only
   scope is `canvas-drop`.
2. **Registration.** `POST {base}/register` (Dynamic Client Registration).
3. **Authorization.** `{base}/authorize` opens the instance's normal sign-in; identity is
   resolved server-side by the same auth strategy the dashboard uses, then checked
   against the email-domain allowlist and the blocked flag. In `oidc` mode a signed-out
   browser goes through the usual login and back; in `proxy` and `dev` mode identity is
   already present, and a request without it is denied. PKCE `S256` is required.
4. **Tokens.** `POST {base}/token` exchanges the single-use code (60 s lifetime) for an
   access token (`expires_in: 3600`) and a refresh token. Refresh tokens rotate on every
   use. `POST {base}/revoke` revokes.

Every tool call carries `Authorization: Bearer <access_token>`. The server looks the
token up and re-checks that the account is still active on each call, so blocking a
user or removing their email domain from the allowlist ends a live token on the next
request. A rejected token answers `401 { "error": "unauthorized" }` with a
`WWW-Authenticate` header pointing at the protected-resource metadata. Nothing the
client asserts about identity reaches the tools.

## How every tool behaves

- **Results.** Success returns the JSON result as text content. Failure returns
  `CODE: message` as text with `isError: true`. Codes are stable; messages are for
  humans.
- **Ids, not slugs.** A canvas tool's `id` is the canvas id. A team tool's `id` is the
  team id.
- **Scope.** Canvas tools see the canvases you own or edit. A canvas you hold no role on,
  including one you can only view, reads as `canvas not found`: no existence leak, no
  cross-account management. Admins get no extra reach on this surface.
- **Roles.** An editor can do everything the owner can except `delete_canvas`,
  `transfer_canvas`, and the guest-AI fields of `update_canvas` (`guestAiEnabled`,
  `guestAiCap`). Those answer `OWNER_ONLY: …` for an editor. Roles are resolved on every
  call; a demotion or removal applies to your next request.
- **Disabled canvases.** When an admin has disabled a canvas, read tools keep working and
  every mutation answers `DISABLED: This canvas has been disabled by an administrator.`
  (plus the reason when one was given), the same contract as the management API's
  `409 { "code": "DISABLED" }`. Only an admin can re-enable it.
- **Archived canvases.** Deploy, publish, and rollback refuse with `NOT_ACTIVE: …`; call
  `unarchive_canvas` first.
- **Limits.** Calls are rate-limited per account using the canvas-API bucket
  (`CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN`, default 120 per minute); over the limit
  answers `429` with `Retry-After`. Request bodies above 110 MB answer `413`.
- **Audit.** Every mutation writes the same audit event as its dashboard equivalent.

Refusal codes you will meet across tools:

| Code | Meaning |
|---|---|
| `OWNER_ONLY` | An editor called an owner-only act, or tried to change the `owner` entry. |
| `DISABLED` | Admin takedown; the canvas is read-only. |
| `NOT_ACTIVE` | The canvas is archived. |
| `GUEST_VIEWER_ONLY` | `editor` was requested for a guest (an email outside the org); guests are always viewers. |
| `PUBLIC_LINK_OWNER_GATED` | The owner's account cannot publish public links; the entitlement follows the owner, whoever acts. |
| `DRAFT_CONFLICT` | A stale draft write; see the draft tools. |
| `INVALID_REQUEST` | Mutually exclusive inputs were both supplied, or neither was. |

## Tools

46 tools. Optional inputs are marked `?`. "View" is the canvas projection described
under Return shapes below.

### Account, lists, create

Available to any signed-in account.

| Tool | Input | Result |
|---|---|---|
| `whoami` | none | `{id, email, name, orgs: [{id, name}], teams: [{id, name, slug, orgId}], isGuest}`. `orgs` is empty when no org boundary is configured; `isGuest` is true only when an org boundary exists and you belong to no org. |
| `list_canvases` | `role?` (`owned` \| `edited`), `query?`, `tags?` (string[]), `sort?` (`updated` default, `created`, `title`, `popular`), `limit?` (1-100, default 50) | `{total, canvases: [View + {owner: {id, name, email}, role: "owner" \| "editor", recentViews}]}`. `query` is a forgiving text filter over title, description, tags, and slug (case-, accent-, and whitespace-insensitive; words are AND-ed). `tags` matches canvases carrying any of the given tags. `popular` ranks by views in the last 30 days (`recentViews`). |
| `list_shared_canvases` | `query?`, `sort?` (`updated` default, `title`, `owner`), `limit?` (default 50), `offset?` (default 0) | `{total, limit, offset, canvases: [{id, slug, url, title, description, tags, access: {kind: "direct" \| "team" \| "whole_org", label, teamIds?, teamNames?}, hasPassword, hasPreview, owner, createdAt, updatedAt}]}`. Canvases you can open but do not manage: direct Specific-people grants plus the Team and Whole-org shares their owner listed. Display-only; open the `url`. |
| `create_canvas` | `title?`, `description?`, `backendEnabled?`, `slug?` (≤63), `orgId?` (string or null) | View + `apiKey` (the deploy key, returned once) + `deploy` (ready-to-run endpoints, see Return shapes). `orgId` from `whoami.orgs` homes the canvas in that org so it can be shared org-wide; omit it for a personal canvas. `ORG_FORBIDDEN`, `INVALID_SLUG`, `SLUG_TAKEN`. |
| `clone_canvas` | `id` (the source) | View of the new canvas: an unpublished draft with a fresh slug and key, backend off. Eligible sources: any active canvas you own or edit, a gallery-listed templatable canvas, or a Team canvas whose granted team you belong to. Anything else reads `canvas not found`. |

### Read a canvas

Minimum role: editor.

| Tool | Input | Result |
|---|---|---|
| `get_canvas` | `id` | View + `owner`, `role`, `teamIds` (when `access` is `team`), `ownerOnlyActs: ["delete", "transfer", "guest_ai"]`, and `deploy` with a `$CANVAS_KEY` placeholder (the key is never re-issued). |
| `list_versions` | `id` | `{versions: [{number, source, status, createdBy, createdByName, createdByEmail, createdAt, fileCount, totalBytes, current, downloadUrl}]}`. `downloadUrl` is `{base}/mcp/canvases/{id}/versions/{n}/download`, a ZIP of that version. |
| `get_canvas_file` | `id`, `path?` | Without `path`: `{version, fileCount, files: [{path, size, mime, hash}]}` for the live version. With `path`: `{version, path, size, mime, hash, encoding: "utf8" \| "base64", content}`. A file over 256 KiB returns `truncated: true` and a `note` instead of `content`; compare the `hash`. Fails when the canvas has no live version. |
| `get_canvas_usage` | `id` | `{totalViews, uniqueViewers, lastViewedAt, viewsByDay, kvOps, fileOps, fileCount, fileBytes, aiCalls, aiTokens, aiCostUsd, realtimeConnects}`. |
| `list_access` | `id` | `{entries: [{id, kind, role, email, name, userId, teamId, teamOrgId, createdAt}]}`: the owner first, then people, pending sign-in grants, and teams. `role` is `owner`, `viewer`, or `editor`. Entry ids are stable (`owner`, `member:<id>`, `guest:<id>`, `pending:<id>`, `team:<teamId>`); pass them to `set_access_role` and `revoke_access`. When you are the owner the result also carries `transferCandidates: [{id, name, email}]`, the set `transfer_canvas` accepts. |
| `search_people` | `context` (`canvas` \| `team`), `canvasId?`, `teamId?`, `q` (1-80 chars) | `{people: [{id, email, name}]}`: the dashboard's Add person suggestions, scoped to a canvas you own or edit (`canvasId`) or a team you can see (`teamId`). `INVALID_REQUEST` when the matching id is missing. Does not expose the admin People directory. |

### Deploy

Minimum role: editor; the canvas must be active. Every deploy goes live at once as a new
immutable version. There is no draft step on this path; for a draft, use the editor
tools below.

| Tool | Input | Result |
|---|---|---|
| `deploy_canvas` | `id`, and exactly one of `zipBase64` or `files: [{path, content, encoding?: "utf8" \| "base64"}]` | `{url, version, fileCount, totalBytes, warnings: []}`. `INVALID_REQUEST` for both or neither. Ingest failures use the Deploy API codes: `EMPTY_DEPLOY`, `TOO_MANY_FILES`, `FILE_TOO_LARGE`, `CANVAS_TOO_LARGE`, `INVALID_ZIP`, `INVALID_PATH`, `INVALID_ENCODING`, `ZIP_SLIP_REJECTED`, `ZIP_BOMB_REJECTED`. |
| `begin_deploy` | `id`, `manifest: [{path, hash, size}]` (`hash` is the sha256 hex of the bytes) | `{uploadId, missingHashes}`: the blobs the server does not already hold. The handle lives 15 minutes. `INVALID_MANIFEST`. |
| `add_files` | `id`, `uploadId`, `files: [{path, content, encoding?}]` | `{staged: <count>}`. Call repeatedly to chunk. `UPLOAD_HANDLE_INVALID`, `UPLOAD_EXPIRED`, `UPLOAD_ALREADY_FINALIZED`, `UPLOAD_UNEXPECTED_BLOB`, `BLOB_HASH_MISMATCH`. |
| `finalize_deploy` | `id`, `uploadId` | Same result as `deploy_canvas`. Single-use. `UPLOAD_MISSING_BLOB` (stage it and retry), `UPLOAD_IN_PROGRESS` (a 60 s lease), `UPLOAD_ALREADY_FINALIZED`. |

Limits: 100 MB per canvas, 25 MB per file, 2000 files. Read "Which deploy tool to use"
below before sending bytes through a tool call.

### Versions and lifecycle

Minimum role: editor unless marked owner-only.

| Tool | Input | Result |
|---|---|---|
| `rollback_canvas` | `id`, `version` (integer) | View + `version`. The target must be a ready version. |
| `unpublish_canvas` | `id` | `{url, publicationState: "draft", currentVersionId: null}`. Takes the canvas offline and drops live sockets. `CANNOT_UNPUBLISH`. |
| `delete_version` | `id`, `version` (integer > 0) | `{ok: true, version}`. The current version is protected (`CURRENT_VERSION`); also `VERSION_NOT_FOUND`, `VERSION_UNAVAILABLE`. Blobs shared with other versions or the draft are retained. |
| `archive_canvas` | `id` | View with `status: "archived"`. Reversible; takes the URL offline and revokes any retained legacy guest sessions. `NOT_ACTIVE`. |
| `unarchive_canvas` | `id` | View + `owner`, `role`, with `status: "active"`. `NOT_ARCHIVED`. |
| `delete_canvas` (owner-only) | `id` | `{ok: true}`. Soft-delete: the URL stops resolving and the canvas is purged after the retention window. Refused on a disabled canvas. Not reversible over MCP. |
| `transfer_canvas` (owner-only) | `id`, `toUserId` (a user id, never an email) | `{ok: true, canvas: View, previousOwnerEditor, publicLinkReverted}`. Instant: the recipient, an existing editor (see `transferCandidates`), becomes owner and you stay on as an editor; the public-link entitlement now follows their account, and `publicLinkReverted` tells you if a public link had to be turned off. A team cannot receive a canvas. `NOT_ELIGIBLE`, `TARGET_NOT_FOUND`, `TARGET_BLOCKED`, `TARGET_NOT_MEMBER`, `ALREADY_OWNER`, `SELF`, `CONFLICT`. |

### Settings

Minimum role: editor.

| Tool | Input | Result |
|---|---|---|
| `update_canvas` | `id` plus any of: `title` (≤200), `description` (≤2000; null clears), `access` (`private` \| `specific_people` \| `team` \| `whole_org` \| `public_link`), `discoverability` (`link_only` \| `listed`), `teamIds` (string[], ≤50), `password` (null clears), `sharedExpiresAt` (Unix ms; null clears), `spaFallback`, `previewMode` (`auto` \| `off`), `galleryListed`, `galleryTemplatable`, `tags` (≤20, each ≤50 chars), and the owner-only `guestAiEnabled`, `guestAiCap` | View + `owner`, `role`, `teamIds?`, and sometimes `warning` (an edge-cache staleness notice when restricting a formerly public canvas; surface it to the user). Omitted fields are unchanged. |
| `set_capabilities` | `id`, `backendEnabled?`, `kv?`, `files?`, `ai?`, `realtime?`, `authoring?` (all booleans) | View + `owner`, `role`. `backendEnabled` is the master switch; the others take effect only when it is on. `authoring` also needs the instance switch on. Omitted fields are unchanged; switching a capability off drops sockets that lost access. |
| `set_canvas_slug` | `id`, `slug?` (≤63; omit for a fresh random slug) | View + `deploy`. The old URL stops resolving immediately. `INVALID_SLUG`, `SLUG_TAKEN`. |
| `set_canvas_preview` | `id`, `image?` (base64 PNG, JPEG, or WebP; decoded ≤25 MB) | View + `owner`, `role`. With `image`, `previewMode` becomes `custom` and a publish never overwrites the cover; without it, the custom cover is cleared back to `auto`. `INVALID_IMAGE`, `IMAGE_TOO_LARGE`. |
| `regenerate_deploy_key` | `id` | `{apiKey, deploy}`. Mints a new `cd_…` key (returned once) and invalidates the old one. An editor may rotate it; the owner is emailed naming the actor. |

Notes on `update_canvas`:

- Sharing and listing need a published canvas (`SHARE_REQUIRES_PUBLISH`,
  `NOT_PUBLISHED`). `public_link` needs the instance switch on (`PUBLIC_LINKS_DISABLED`)
  and an entitled owner (`PUBLIC_LINK_OWNER_GATED`). A password un-lists from the gallery
  (`PASSWORD_PROTECTED`).
- To share with teams, set `access: "team"` and `teamIds` with at least one team you
  belong to. Personal teams fit any canvas you own; org teams must match the canvas's org
  (`TEAM_REQUIRED`, `TEAM_FORBIDDEN`). Leaving the `team` rung clears the grants.
- `discoverability` controls only whether a Team or Whole-org canvas appears in Shared;
  it never widens URL access. Setting `galleryListed: true` on a Whole-org canvas also
  sets `discoverability: "listed"`.
- The Specific-people list itself is managed with `grant_access` and `revoke_access`.

### Sharing and people

Minimum role: editor.

| Tool | Input | Result |
|---|---|---|
| `grant_access` | `id`, exactly one of `email` or `teamId`, `role?` (`viewer` default \| `editor`) | Person: `{ok: true, status: "granted" \| "pending" \| "role_changed", role, emailDelivery?}`. An existing user is granted now; an admissible new email becomes a pending sign-in grant that carries the role; passing `role` for someone already listed updates it, and omitting it never changes an existing entry. Team: `{ok: true, status: "granted" \| "role_changed" \| "already_added", role, from}`. Only org members and teams can be editors (`GUEST_VIEWER_ONLY`). A viewer grant takes effect on the `specific_people` and `team` rungs; an editor always has access. Also `NOT_PERMITTED`, `AUTH_ADMISSION_REQUIRED`, `BLOCKED`, `RATE_LIMITED`, `TEAM_FORBIDDEN`, `EMAIL_NOT_CONFIGURED`. |
| `invite_to_canvas` | `id`, `email`, `role?` | The same person result as `grant_access`, through the same Add person service, and it sends the access email. A brand-new external email is refused for a non-admin unless the instance allows it (`NOT_PERMITTED`); `RATE_LIMITED` past the cap. |
| `revoke_access` | `id`, `entryId` (from `list_access`) | `{ok: true}`. Removes a person (another editor, or yourself), a pending grant, a legacy guest row, or a team grant; sockets the entry no longer permits are dropped. The `owner` entry refuses (`OWNER_ONLY`). |
| `set_access_role` | `id`, `entryId`, `role` (`viewer` \| `editor`) | `{ok: true}`. A guest can only be a viewer (`GUEST_VIEWER_ONLY`); the `owner` entry refuses (`OWNER_ONLY`; use `transfer_canvas`). Demoting drops the person's live editor sockets. |

### Draft editor loop

Minimum role: editor. These mirror the browser editor: a per-canvas draft that
`publish_draft` snapshots into a live version. DraftView is
`{files: [{path, size, mime, hash, updatedBy, updatedByName, updatedAt}], stale, baseVersionId, updatedAt, dirty}`,
where `dirty` means the draft differs from live.

| Tool | Input | Result |
|---|---|---|
| `get_draft` | `id` | DraftView. Created from the live version on first open. |
| `read_draft_file` | `id`, `path` | `{path, encoding, content, hash, updatedBy, updatedByName, updatedAt}`. |
| `write_draft_file` | `id`, `path`, `content`, `encoding?`, `create?`, `expectedHash?` | DraftView. `create: true` refuses to overwrite (`PATH_EXISTS`). `expectedHash` is the `hash` you loaded, or the literal `none` for a path you believe absent; a mismatch fails with `DRAFT_CONFLICT: … (path= currentHash= updatedBy= updatedByName= updatedAt=)`: re-read and retry with the current hash. Without `expectedHash` the write still fails with `DRAFT_CONFLICT` if a different user wrote that file last. Two editors in different files never conflict. |
| `delete_draft_file` | `id`, `path`, `expectedHash?` | DraftView. |
| `rename_draft_file` | `id`, `from`, `to`, `expectedHash?` (checked on `from`) | DraftView. |
| `publish_draft` | `id` | `{version, versionId, fileCount, totalBytes}`. `NOT_ACTIVE`, `EMPTY_DEPLOY`, `DISABLED`. |
| `restore_draft` | `id`, `version` (integer > 0) | DraftView, reset to that version's files. |

### Teams

Available to any signed-in account; self-serve only, with no admin reach. Here `id` is
a team id.

| Tool | Input | Result |
|---|---|---|
| `list_teams` | none | `{teams: [{id, orgId, name, slug, mine, canManage}]}`. `mine`: you belong to it. `canManage`: you created it, so you can rename or delete it. |
| `create_team` | `orgId?` (string or null), `name` (1-80 chars) | `{id, orgId, name, slug}`. Omit `orgId` for a personal team; pass one from `whoami.orgs` to attach the team to that org. You become its first member and its manager. |
| `rename_team` | `id`, `name` | `{id, name}`. |
| `delete_team` | `id` | `{ok: true}`. Every canvas shared with the team is unshared; the canvases are untouched. |
| `add_team_member` | `id`, `email` | `{status: "granted" \| "pending", emailDelivery?}`. An org team takes same-org members only; a brand-new external email on a personal team is refused for a non-admin unless the instance allows it. |
| `remove_team_member` | `id`, `userId` | `{ok: true}`. Pass your own id to leave. |
| `cancel_team_invite` | `id`, `inviteId` (a `pending` row id from `list_team_members`) | `{ok: true}`. |
| `list_team_members` | `id` | `{members: [{userId, email, name}], pending: [{id, email, invitedAt}]}`. |

Team error codes: `NOT_A_MEMBER`, `TEAM_NOT_FOUND`, `TEAM_NAME_TAKEN`, `FORBIDDEN`,
`TARGET_NOT_FOUND`, `TARGET_NOT_MEMBER`, `TARGET_NOT_PERMITTED`, `TARGET_BLOCKED`,
`AUTH_ADMISSION_REQUIRED`, `RATE_LIMITED`.

## Return shapes

**View**, the canvas projection every canvas tool echoes:

```
{ id, slug, url, ownerId, title, description, status, publicationState,
  currentVersionId, access, discoverability, hasPassword, sharedExpiresAt,
  spaFallback, backendEnabled, disabledReason, galleryListed, galleryTemplatable,
  tags, guestAiEnabled, guestAiCap, previewMode, viewCount, lastViewedAt,
  hasPreview, previewUrl? }
```

`publicationState` is `draft`, `published`, `archived`, `disabled`, or `deleted`.
Identity-bearing tools add `owner` and `role`. The password hash and the API key are
never included.

**deploy**, returned by `create_canvas`, `get_canvas`, `set_canvas_slug`, and
`regenerate_deploy_key`: the exact keyed [Deploy API](/docs/api/deploy-api) endpoints
for this canvas, so there is nothing to probe.

```json
{
  "apiBase": "https://api.example.com/v1/canvases/{id}",
  "zipUpload": "PUT https://api.example.com/v1/canvases/{id}/deploy",
  "staged": {
    "begin": "POST https://api.example.com/v1/canvases/{id}/uploads",
    "stageBlob": "PUT https://api.example.com/v1/canvases/{id}/uploads/{uploadId}/blobs/{hash}",
    "finalize": "POST https://api.example.com/v1/canvases/{id}/uploads/{uploadId}/finalize"
  },
  "readback": "GET https://api.example.com/v1/canvases/{id}/files",
  "curl": "curl -X PUT \"https://api.example.com/v1/canvases/{id}/deploy\" -H \"Authorization: Bearer $CANVAS_KEY\" --data-binary @site.zip"
}
```

`create_canvas` and `regenerate_deploy_key` embed the real key in `curl` (returned
once); `get_canvas` and `set_canvas_slug` show the `$CANVAS_KEY` placeholder, so set it
from your own copy. The host is `CANVAS_DROP_API_BASE_URL`, falling back to
`CANVAS_DROP_BASE_URL`. In `subdomain` mode it usually differs from the canvas hosts,
which is why you should use the advertised endpoints rather than guessing.

## Which deploy tool to use

`deploy_canvas` sends the whole payload in one call: use it for the first publish of a
small canvas. Use the staged flow (`begin_deploy`, `add_files`, `finalize_deploy`) when
the canvas already has content or has many, large, or binary files. Fresh tiny canvas:
`deploy_canvas`. Everything else: staged.

The staged flow:

1. `begin_deploy` with the full manifest (`path`, `hash` as sha256 of the bytes, `size`).
   The reply's `missingHashes` lists the blobs the server does not already hold. Storage
   is content-addressed, so an unchanged file is never re-sent; a re-deploy that changed
   one file sends one file.
2. `add_files` with the contents for those hashes, in as many calls as you like.
3. `finalize_deploy` to publish. The handle is single-use and short-lived; a finalize
   that is missing a blob fails cleanly and can be retried after staging it.

Over MCP, `add_files` content still travels in the tool call. The saving comes from not
resending unchanged files and from chunking.

**Prefer `curl` and the keyed Deploy API for the file transfer whenever you can run
shell commands.** Every MCP deploy tool inlines file contents into the tool call, so they
pass through the model. If you lack command or network permission, request it rather
than inlining bytes. The same staged flow runs over plain HTTP: `POST …/uploads` with
the manifest, `PUT …/uploads/{uploadId}/blobs/{hash}` with each blob's raw bytes, then
`POST …/uploads/{uploadId}/finalize`. The bytes go from disk to the server without
entering the model context, with no tool-call size ceiling. `create_canvas` returns the
per-canvas key and the exact URLs in its `deploy` block. Reserve the MCP deploy tools
for a small first publish when shell access is unavailable.

## Verify a deploy

The live URL is access-controlled, so do not confirm a deploy by fetching it: an
unauthenticated `GET` returns a login page, not your files. Verify through the server:

- The deploy or finalize result already returns `{url, version, fileCount, totalBytes}`.
- `list_versions` shows the new version as `current`.
- `get_canvas_file` reads back what is live: no `path` lists the live files (`path`,
  `size`, `mime`, `hash`); a `path` such as `index.html` returns that file's content
  (text as UTF-8, binary as base64; files over 256 KiB return their hash only, so compare
  it to what you deployed).
- Over curl, the same read-back is `GET {apiBase}/files`, with `?path=` for raw bytes and
  no size cap. `apiBase` comes from the `deploy` block.

Each `list_versions` row carries a `downloadUrl` for a complete ZIP export of that
immutable version. Fetch it with the same OAuth access token in the
`Authorization: Bearer …` header; the route accepts no query-string token and no
dashboard cookie, and answers `503 VERSION_INCOMPLETE` rather than a partial archive
when a referenced blob is missing.

## Enabling and disabling

The MCP surface is on by default. `CANVAS_DROP_MCP=off` removes the `/mcp` endpoint,
the version download route, and the OAuth routes entirely (they are not mounted, so they
answer like any unknown path). See [Configuration](/docs/self-hosting/configuration).

## Which path should an agent use?

- **MCP**: your host speaks MCP and you want a connect-once, multi-canvas,
  identity-scoped surface with the draft editor, sharing, and teams.
- **[Deploy API](/docs/api/deploy-api)** (HTTP with a per-canvas key): a keyed,
  sessionless agent or a CI step that holds one canvas's key. Also the right transport
  for the bytes of any large deploy, even from an MCP session.
- The packaged **[Agent skill](/docs/agents/skill)** documents both for a coding agent,
  and **[`/llms.txt`](/llms.txt)** is the single-file quick reference.

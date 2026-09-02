# llms.txt

If you are an agent putting a canvas on a canvas-drop instance, start here. The
instance serves this page and its companions (Overview, Quickstart, Capabilities,
SDK overview, Deploy API, Runtime API, Error codes) as one plain-text file at
[`{base}/llms.txt`](/llms.txt), meant to be dropped straight into context. It is
public: served on the instance's base host ahead of the sign-in gateway, so you
can read the contract before you hold any credential. `{base}` is the instance
origin (a fresh local instance is `http://localhost:3000`).

There are three ways in. Pick by what you hold.

| You hold | Use | Reach |
|---|---|---|
| A per-canvas secret key (`cd_...`) | Deploy API at `{base}/v1/canvases/{id}/...` | that one canvas: deploy, read back, roll back, unpublish |
| An MCP-capable host | MCP at `{base}/mcp` (OAuth 2.1, no key to paste) | every canvas the signed-in account owns or edits; 46 tools |
| Code running inside a canvas page | Browser SDK at `{base}/sdk/v1.js`, global `canvasdrop` | the five primitives for that canvas: KV, files, AI, identity, realtime |

Two verbs recur below. **Publish** turns the editor draft into an immutable
version. **Deploy** (the Deploy API, `deploy_canvas`, the staged upload) publishes
directly with no draft step. Both create a new version at the same URL; the last
10 versions are kept.

## Deploy with a key

1. Get a canvas and its key. A person creates the canvas on the dashboard's
   Create page with **Use the API**, or you call `create_canvas` over MCP. Either
   mints the canvas plus a one-time secret key, shown once.
2. PUT a ZIP with `index.html` at its root:

```bash
curl -fsS -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
# 200 {"url":"...","version":7,"fileCount":12,"totalBytes":348201,"warnings":[]}
```

3. Verify through the server, not the URL:

```bash
curl -fsS "{base}/v1/canvases/{id}/files" -H "Authorization: Bearer $CANVAS_KEY"
# 200 {"version":7,"fileCount":12,"files":[{"path":"index.html","size":1204,"mime":"text/html","hash":"..."}]}
curl -fsS "{base}/v1/canvases/{id}/files?path=index.html" \
  -H "Authorization: Bearer $CANVAS_KEY" | sha256sum
# the live file's raw bytes; compare the hash with what you shipped
```

The deploy publishes a live version immediately. `{id}` is the canvas id, not the
slug. The Deploy API host is `CANVAS_DROP_API_BASE_URL`, which defaults to the
instance base URL and can differ from the dashboard host; `create_canvas` and the
dashboard both return the exact endpoints for the canvas, so never guess the host.

The key is verified per canvas. A missing or unknown key, including a key for an
archived, disabled, or deleted canvas, answers `401 {"error":"unauthorized"}`; a key
for a different canvas answers `403`. Validation failures answer `{"code",
"message","path"}`: `400` on the ZIP path with `EMPTY_DEPLOY`, `TOO_MANY_FILES`,
`FILE_TOO_LARGE`, `CANVAS_TOO_LARGE`, `INVALID_ZIP`, `INVALID_PATH`,
`ZIP_SLIP_REJECTED`, or `ZIP_BOMB_REJECTED`; a ZIP body over the canvas cap is
refused before it is read with `413 CANVAS_TOO_LARGE`. Deploys, staged
begin/finalize, and rollbacks are throttled at 10 per minute per canvas
(`429 {"error":"rate_limited"}` with `Retry-After`).

Companion routes, same Bearer key:

| Route | Purpose |
|---|---|
| `GET /v1/canvases/{id}` | `{id, slug, url, title, status, publicationState, currentVersionId}` |
| `GET /v1/canvases/{id}/versions` | `{versions: [{number, source, status, createdBy, createdAt, fileCount, totalBytes, current}]}` |
| `GET /v1/canvases/{id}/files` | the live manifest as JSON; `?path=` returns that file's raw bytes; `404 NOT_PUBLISHED` before the first deploy |
| `POST /v1/canvases/{id}/rollback` | body `{"version": 6}`; makes that ready version current and returns `{url, version}`; `404` when no ready version has that number |
| `POST /v1/canvases/{id}/unpublish` | back to Draft: `{url, publicationState: "draft", currentVersionId: null}`; `409 CANNOT_UNPUBLISH` when not published |

For large or repeat deploys, the staged flow sends only changed blobs:
`POST /v1/canvases/{id}/uploads` with `{"manifest":[{"path","hash","size"}]}`
(sha256 hex) returns `{uploadId, missingHashes}`; `PUT
/v1/canvases/{id}/uploads/{uploadId}/blobs/{hash}` with the raw bytes of each
missing blob returns `204`; `POST /v1/canvases/{id}/uploads/{uploadId}/finalize`
returns the same `DeployResult`. A session lives 15 minutes and finalizes once.
Staged errors use the same `{code, message}` shape at a mapped status: size caps
`413`; an unknown or foreign `uploadId` `404 UPLOAD_HANDLE_INVALID`;
`UPLOAD_ALREADY_FINALIZED` and `UPLOAD_IN_PROGRESS` `409`; `UPLOAD_EXPIRED`,
`UPLOAD_MISSING_BLOB`, `BLOB_HASH_MISMATCH`, `INVALID_MANIFEST` `400`.

Limits: 100 MB per canvas, 25 MB per file, 2 000 files. Full contract:
[Deploy API](/docs/api/deploy-api).

## Connect over MCP

Add `{base}/mcp` to an MCP-capable host. First use runs OAuth 2.1 against
canvas-drop itself (RFC 8414/9728 discovery, Dynamic Client Registration, PKCE
`S256`), sends you through the instance's normal org sign-in, and returns a 1 h
access token plus a rotating refresh token. Every call re-checks that the account
is still active. Transport is Streamable HTTP, stateless; calls are limited to 120
per minute per account and request bodies to 110 MiB. An instance with
`CANVAS_DROP_MCP=off` has no `/mcp` endpoint at all.

A first session, as tool calls:

```
whoami           {}                             -> { id, email, name, orgs, teams, isGuest }
create_canvas    { "title": "Retro board" }     -> { id, slug, url, apiKey, deploy, ... }   apiKey is returned once
deploy_canvas    { "id": "<id>", "files": [{ "path": "index.html", "content": "<h1>Hi</h1>" }] }
                                                -> { url, version: 1, fileCount: 1, totalBytes, warnings: [] }
get_canvas_file  { "id": "<id>", "path": "index.html" }
                                                -> { version, path, size, mime, hash, encoding: "utf8", content }
```

**Scope and roles.** Tools act on the canvases the account owns or edits. A canvas
you hold no role on reads as `canvas not found`, for admins too. Each tool has a
minimum role: `any` (identity, lists, create, teams), `editor` (everything on a
canvas), or `owner` (`delete_canvas`, `transfer_canvas`). An editor calling an
owner-only tool, or setting `guestAiEnabled` / `guestAiCap` through `update_canvas`,
gets `OWNER_ONLY: ...`; `get_canvas` echoes the list as `ownerOnlyActs: ["delete",
"transfer", "guest_ai"]`. `id` parameters are canvas ids (team tools take team
ids), never slugs. Results are JSON in a text content block; failures are
`isError: true` with the text `CODE: message`. An admin-disabled canvas stays
readable but every mutation fails `DISABLED: ...`; an archived canvas refuses
deploy and publish with `NOT_ACTIVE`.

| Group | Tools |
|---|---|
| Identity, lists, create (`any`) | `whoami`, `list_canvases`, `list_shared_canvases`, `create_canvas`, `clone_canvas` |
| Read (`editor`) | `get_canvas`, `list_versions`, `get_canvas_file`, `get_canvas_usage`, `list_access`, `search_people` |
| Deploy (`editor`; publishes live immediately) | `deploy_canvas`, `begin_deploy`, `add_files`, `finalize_deploy` |
| Lifecycle (`editor` unless marked) | `rollback_canvas`, `unpublish_canvas`, `delete_version`, `archive_canvas`, `unarchive_canvas`, `delete_canvas` (owner), `transfer_canvas` (owner) |
| Settings (`editor`) | `update_canvas`, `set_capabilities`, `set_canvas_slug`, `set_canvas_preview`, `regenerate_deploy_key` |
| Sharing (`editor`) | `grant_access`, `invite_to_canvas`, `revoke_access`, `set_access_role` |
| Draft loop (`editor`) | `get_draft`, `read_draft_file`, `write_draft_file`, `delete_draft_file`, `rename_draft_file`, `publish_draft`, `restore_draft` |
| Teams (`any`) | `list_teams`, `create_team`, `rename_team`, `delete_team`, `add_team_member`, `remove_team_member`, `cancel_team_invite`, `list_team_members` |

Working notes:

- Typical flow: `create_canvas`, deploy, verify. `create_canvas` returns the canvas
  view, the one-time `apiKey`, and a `deploy` block (`apiBase`, `zipUpload`,
  `staged.begin` / `stageBlob` / `finalize`, `readback`, and a ready-to-run `curl`
  with the key filled in). A new canvas is empty and `private`; its URL serves
  content only after a deploy.
- Prefer `curl` for bytes. `deploy_canvas` takes exactly one of `zipBase64` or
  `files: [{path, content, encoding?}]` (`utf8` default, or `base64`) and, like
  `add_files`, inlines file content into the model context. When you can run
  shell commands, use the `deploy` block's curl, whole ZIP or staged; keep
  `deploy_canvas` for a small first publish without a shell.
- Verify through the server, not the URL. The live URL is behind org sign-in: a
  signed-out GET is redirected to login (`oidc`) or answered `401` (`proxy`, `dev`)
  unless the canvas is on the `public_link` rung. Check the returned
  `{version, fileCount}`, `list_versions`, the `readback` URL, or `get_canvas_file`
  (no `path` lists the manifest; a `path` returns the content as `utf8` or
  `base64`; over 256 KiB it returns `truncated: true` instead).
- `list_canvases` returns owned and edited canvases, each with `role`
  (`"owner"` or `"editor"`) and `owner`; the `role` parameter (`owned` or `edited`)
  narrows. `query` is a forgiving filter over title, description, tags, and slug
  (case, accent, and whitespace insensitive; multiple words AND). `tags` is
  any-match. `sort` is `updated` (default), `created`, `title`, or `popular` (views
  over the last 30 days). `limit` defaults to 50, max 100. `list_shared_canvases`
  lists canvases you can open but do not manage: a direct grant, a listed team
  share, or a listed whole-org share.
- Draft loop: `write_draft_file`, `delete_draft_file`, and `rename_draft_file` take
  `expectedHash` (the file's current `hash` from `get_draft` / `read_draft_file`,
  or `"none"` for a path you expect absent); a mismatch fails `DRAFT_CONFLICT` with
  the current hash and last writer. Without `expectedHash` the write still fails
  `DRAFT_CONFLICT` when a different user wrote the file last, so two editors never
  overwrite each other silently. `write_draft_file` with `create: true` refuses an
  existing path (`PATH_EXISTS`). `publish_draft` snapshots the draft into a live
  version and returns `{version, versionId, fileCount, totalBytes}`.
- `update_canvas` fields: `title` (max 200), `description` (max 2000, or `null`),
  `tags` (max 20, each max 50 chars; one set serves list filtering and the gallery),
  `access`, `discoverability` (`link_only` by default; `listed` shows a Team or
  Whole-org canvas in Shared and makes a Whole-org canvas gallery-eligible),
  `teamIds`, `password` (or `null` to clear), `sharedExpiresAt` (unix ms, or `null`),
  `spaFallback`, `previewMode` (`auto` or `off`; `set_canvas_preview` with an image
  sets `custom`), `galleryListed`, `galleryTemplatable`, and the owner-only
  `guestAiEnabled` / `guestAiCap`. Refusals you will meet: `SHARE_REQUIRES_PUBLISH`
  (sharing needs a published canvas), `ORG_REQUIRED`, `PUBLIC_LINKS_DISABLED`
  (instance switch off), `PUBLIC_NOT_ALLOWED` (the owner may not publish publicly),
  `PUBLIC_LINK_OWNER_GATED` (an editor asked for `public_link` on such a canvas),
  `TEAM_REQUIRED` / `TEAM_FORBIDDEN`. `set_capabilities` takes `backendEnabled`,
  `kv`, `files`, `ai`, `realtime`, `authoring`.
- People: `list_access` entries are `viewer` or `editor`; the owner also gets
  `transferCandidates`. `grant_access` takes exactly one of `email` or `teamId` plus
  `role`; a new email is `pending` until its first verified sign-in through the
  instance's identity provider; legacy guests are viewers only
  (`GUEST_VIEWER_ONLY`). `set_access_role` changes an entry's role.
  `transfer_canvas` takes a user id (never an email) of an existing editor
  (`NOT_ELIGIBLE` otherwise) and returns `{ok, canvas, previousOwnerEditor,
  publicLinkReverted}`: the previous owner keeps editor access while their account
  is active, and a `public_link` rung reverts when the new owner lacks the
  entitlement.
- Tenancy: `whoami` returns `orgs`, `teams`, and `isGuest` (true only when an org
  boundary is configured and you belong to none). `create_canvas.orgId`: omit to
  default to your only org, pass `null` for a personal canvas; an org you do not
  belong to fails `ORG_FORBIDDEN`. Under an active org boundary the `whole_org`
  rung needs an org-homed canvas (`ORG_REQUIRED`).
- Versions: `list_versions` carries a `downloadUrl` per version
  (`{base}/mcp/canvases/{id}/versions/{n}/download`, a ZIP fetched with the same
  MCP access token as a Bearer). `delete_version` removes a non-current version
  only (`CURRENT_VERSION` otherwise).

Parameters and return shapes for every tool: [MCP server](/docs/agents/mcp).

## Browser SDK inside a canvas

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const me = await canvasdrop.me();                     // { id, email, name, avatarUrl, kind }
  await canvasdrop.kv.set("last-viewer", me.name);
  const views = await canvasdrop.kv.increment("views"); // 1 on the first call, then 2, 3, ...
</script>
```

One global, `window.canvasdrop`; there is no `cd` alias and no version property.
Zero config: the slug and API base are read from the page URL (`/c/{slug}/` in
path mode, `{slug}.{host}` in subdomain mode), every call goes to
`{apiBase}/v1/c/{slug}/...` with the session cookie, and no key ever reaches the
page. The root-relative `src` resolves on the canvas's own origin in both modes.
The canvas must have Backend switched on (see Capabilities below); `/sdk/v1.js`
sits behind the same sign-in as the canvas.

- `me()` returns `{ id, email, name, avatarUrl, kind }`. `kind` is `"member"`;
  `"guest"` appears only for retained legacy guest sessions, since new Add person
  grants materialize as signed-in users.
- `kv` (shared) and `kv.user` (per viewer, keyed server-side) have the same five
  methods: `get(key)` returns the value or `null`; `set(key, value)` stores any
  JSON except `null`; `delete(key)` is idempotent; `list({ prefix?, cursor?, limit? })`
  returns `{ entries: [{ key, value }], nextCursor }` (`limit` 1 to 1000, default
  100); `increment(key, by = 1)` returns the new number and fails `NOT_NUMERIC` on
  a non-numeric value. Key max 512 bytes, value max 64 KiB, 10 000 shared and
  1 000 per-user keys per canvas.
- `files`: `upload(file)` returns `{ id, name, size, url }` with an absolute `url`;
  `list()` returns `[{ id, name, size, mime, createdAt }]`; `delete(id)`; `url(id)`
  is synchronous. 25 MiB per file, 1 GiB per canvas.
- `ai`: `chat(messages, { model, system?, maxTokens? })` returns `{ text, usage:
  { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens },
  cost }`; `stream(messages, options)` returns an `AsyncIterable<string>` of text
  deltas with no usage. `model` is required and must be on the instance allowlist
  (`MODEL_NOT_ALLOWED`). Messages are `{ role: "user" | "assistant", content }`; the
  system prompt goes in `options.system`; `maxTokens` defaults to 1024, cap 8192.
  The provider key stays server-side.
- `realtime.channel(name)` returns a handle with `publish(event, data)` (fire and
  forget, buffered while reconnecting), `subscribe(handler)` where `handler`
  receives `{ event, data, from: { id, name } }` and the call returns `void`,
  `unsubscribe()` (clears every handler on the channel), `presence()` resolving to
  `[{ id, name }]`, `onPresence`, `onJoin`, `onLeave`, and `close()`. One shared
  socket per page with automatic reconnect; 30 connections per canvas, 16 KiB per
  message. There is no generic `.on(...)`.
- `canvases` (the `authoring` capability, off by default per canvas and per
  instance): `publish`, `update`, `list`, `revoke` let a signed-in viewer create
  and manage a share canvas from a page.

Full signatures and types: [SDK overview](/docs/sdk/overview). Raw routes:
[Runtime API](/docs/api/runtime-api).

## Sharing and access

One access rung per canvas, set on the Share tab or with `update_canvas.access`.
Access is evaluated on every request, so a revoke, an expiry, or a role change
takes effect on the next request; a canvas you may not open reads as `404`.

| Rung | Who can open it |
|---|---|
| `private` | the owner and editors |
| `specific_people` | people granted directly on the people list: existing users at once, new emails pending until their first verified sign-in |
| `team` | members of the granted teams (`teamIds`); `discoverability: "listed"` shows it in Shared |
| `whole_org` | any signed-in org member; `listed` shows it in Shared and makes it gallery-eligible |
| `public_link` | anyone with the link, while the instance switch is on and the owner may publish publicly (`canPublishPublic`); static only for everyone except the owner and editors: every primitive answers `403 STATIC_ONLY` |

An editor grant, direct or through an editor-role team, opens every rung. Editors
skip the password gate and the share expiry. A password lock answers
`403 PASSWORD_REQUIRED` on the runtime API until the viewer passes the gate; a
share expiry (`sharedExpiresAt`) turns other viewers away with
`404 SHARE_EXPIRED` once it passes. Details: [Sharing & access](/docs/authoring/sharing).

## Capabilities

`backendEnabled` is off by default. With it on, `kv`, `files`, `ai`, and
`realtime` default on and `authoring` defaults off; each toggles independently.
Effective rule: `identity = backend`; `kv = backend && capKv`; `files = backend &&
capFiles`; `ai = backend && capAi && provider key configured`; `realtime = backend
&& capRealtime && CANVAS_DROP_REALTIME=on` (the default); `authoring = backend &&
capAuthoring && CANVAS_DROP_AUTHORING=on` (default `off`).

An off feature answers `403 {"code":"CAPABILITY_DISABLED","capability":"kv",
"backendEnabled":false,"reason":"backend_off"|"feature_off"|"operator_disabled",
"hint":"..."}`; the SDK throws `CapabilityDisabledError`. Toggle from the canvas's
Backend tab, `PATCH /api/canvases/{id}/capabilities`, or `set_capabilities`.
Details: [Capabilities](/docs/authoring/capabilities).

## Errors

Every failure carries a stable string `code`; branch on it, not on message text.
The SDK throws `CanvasdropError` with `.code` and `.status`, plus six subclasses:
`NotAuthenticatedError` (any 401), `NotFoundError` (any 404),
`CapabilityDisabledError` (403 `CAPABILITY_DISABLED`, with `.hint`),
`QuotaExceededError` (`QUOTA_EXCEEDED`, `GUEST_AI_CAP`, `KEY_LIMIT`, and every 413
size code), `PublishFailedError` (502, from `canvasdrop.canvases.publish`, with
the new canvas `.id`), and `UpdatePartialError` (502, from `canvasdrop.canvases.update`
when the settings saved but the bundle deploy failed, with `.stage` and `.current`).
Every other code arrives as a plain `CanvasdropError`.
`kv.get` returns `null` for a missing key instead of throwing.

Codes you will meet most on the runtime API: `401 {"error":"unauthorized"}` (no
session; `oidc` redirects to login instead), `NOT_FOUND` / `ARCHIVED` /
`OWNER_ONLY` / `SHARE_EXPIRED` 404, `DISABLED` 403, `PASSWORD_REQUIRED` 403,
`STATIC_ONLY` 403, `CAPABILITY_DISABLED` 403, `CROSS_CANVAS_FORBIDDEN` /
`CROSS_SITE_FORBIDDEN` 403, `MODEL_NOT_ALLOWED` 403, `INVALID_BODY` 400,
`KEY_TOO_LARGE` / `VALUE_TOO_LARGE` / `FILE_TOO_LARGE` 413, `KEY_LIMIT` 409,
`NOT_NUMERIC` 409, `QUOTA_EXCEEDED` 429 (409 on files), `CONNECTION_LIMIT` 429,
`RATE_LIMITED` 429, `AI_STREAM_TRUNCATED` / `AI_UPSTREAM_ERROR` 502. Full table:
[Error codes](/docs/api/errors).

## Rate limits

Defaults; each is an env var the operator can change.

| Surface | Default | Keyed by | Env var |
|---|---|---|---|
| Deploy API (`deploy`, `uploads` begin, `finalize`, `rollback`) | 10/min | canvas | `CANVAS_DROP_RATELIMIT_DEPLOY_PER_MIN` |
| Runtime API `/v1/c/{slug}/...` | 120/min | user + canvas | `CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN` |
| Runtime AI `/v1/c/{slug}/ai/...` | 10/min | user | `CANVAS_DROP_RATELIMIT_AI_PER_MIN` |
| MCP `/mcp` | 120/min | account | `CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN` |

For a packaged, installable version of this guidance, see the
[Agent skill](/docs/agents/skill).

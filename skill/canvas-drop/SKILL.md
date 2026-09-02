---
name: canvas-drop
description: Deploy and extend small web artifacts ("canvases") on a canvas-drop instance. Use when the user wants to ship static HTML/JS to a shared URL, or give a canvas backend capability (KV, files, AI, identity, realtime) through the zero-config browser SDK. Connect over MCP for an identity-scoped tool surface, or deploy over HTTP with a per-canvas key.
---

# canvas-drop

canvas-drop hosts small static web artifacts ("canvases") at access-controlled URLs
inside an org and gives them backend capability through five primitives: KV, files,
AI, identity, realtime. You can create, deploy, verify, and configure a canvas without
a dashboard session: over MCP as yourself, or over HTTP with a per-canvas key.

`{base}` below is the instance's base URL. Ask the user if you do not know it.

## When to use this skill

- The user wants an HTML/JS prototype, dashboard, demo, or small tool on a URL their
  colleagues can open after signing in.
- The user wants a canvas to persist data, store files, know who is viewing, call an
  AI model, or sync between viewers, with no backend of their own.
- The user wants to inspect, roll back, share, or reconfigure a canvas that exists.

## Rules that always hold

- **No secrets in canvas files.** Canvas HTML/JS carries no API keys, provider keys,
  or tokens. Identity rides the viewer's session cookie; the per-canvas `cd_…` key is
  used only by the deploy step and never ships inside the canvas.
- **Static files only.** No server-side build. AI-generated HTML deploys unmodified.
  Backend behaviour comes only from the five primitives.
- **Backend is off by default.** Every primitive call throws `CapabilityDisabledError`
  (`code: "CAPABILITY_DISABLED"`, status 403) until an owner or editor turns on Backend
  plus the specific feature (dashboard Backend tab, or `set_capabilities` over MCP).
  Identity (`me()`) has no separate toggle; it is on whenever Backend is on.
- **Deploy means live.** A deploy over the key API or the MCP deploy tools creates an
  immutable version and points the canvas at it in one step. The last 10 versions are
  kept; you can roll back to any of them.
- **Public link is static-only.** On a `public_link` canvas the primitives are refused
  for every viewer except the owner and editors (`STATIC_ONLY`, 403). Every other rung
  requires sign-in, and the primitives work for anyone who can open the canvas.

## Pick a path

| You can | Use | Why |
|---|---|---|
| Run shell commands | `curl` against the Deploy API for file transfer (below) | Bytes stream from disk to the server and never pass through your context. Same content-addressed staging the MCP tools use. |
| Speak MCP | `{base}/mcp` for everything else: create, list, verify, roll back, share, capabilities, the draft loop | One sign-in, no key to paste, tools scoped to your identity. |
| Neither yet | Ask for command or network permission | Do this before falling back to inlining file bytes into an MCP deploy call. |

The MCP deploy tools (`deploy_canvas`, `add_files`) inline file bytes into the tool
call. They are fine for a small first publish. For anything large, binary, or repeated,
take the canvas id and key from `create_canvas` and move the bytes with `curl`.

## Connect over MCP

Add the endpoint to your MCP client:

```
{base}/mcp
```

The client runs an OAuth 2.1 sign-in once (the instance's normal login plus a consent
screen). No secret to copy. Every tool then acts as you: a canvas you own or edit is in
scope; a canvas you hold no role on reads as `canvas not found`. Owner-only acts
(`delete_canvas`, `transfer_canvas`, the guest-AI fields of `update_canvas`) fail with
`OWNER_ONLY` for editors. An admin-disabled canvas is read-only: every mutation fails
with `DISABLED: …` until an admin re-enables it. Results are JSON text; failures are
`CODE: message` with `isError: true`. Canvas tools take the canvas `id`, never the slug.

46 tools, grouped:

| Group | Tools | Notes |
|---|---|---|
| Identity and lists | `whoami`, `list_canvases`, `list_shared_canvases` | `list_canvases` takes `role` (`owned` / `edited`), `query` (case-, accent-, and whitespace-insensitive search over title, description, tags, and slug; multi-word AND), `tags` (any-match), `sort`, `limit`. |
| Create | `create_canvas`, `clone_canvas` | `create_canvas(title?, description?, backendEnabled?, slug?, orgId?)` returns the canvas, its `apiKey` (shown once), and a `deploy` block with the exact endpoints (`apiBase`, `zipUpload`, `staged.begin` / `stageBlob` / `finalize`, `readback`, and a copy-paste `curl`). Use them verbatim; do not probe for the API host. `get_canvas` returns the same block with a `$CANVAS_KEY` placeholder. |
| Read | `get_canvas`, `list_versions`, `get_canvas_file`, `get_canvas_usage`, `list_access`, `search_people` | `get_canvas_file(id)` lists the live files; `get_canvas_file(id, path)` returns one file's content (`utf8` or `base64`; over 256 KiB comes back `truncated: true` without content). This is how you verify a deploy. |
| Deploy | `deploy_canvas`, `begin_deploy`, `add_files`, `finalize_deploy` | `deploy_canvas(id, zipBase64)` or `deploy_canvas(id, files: [{path, content, encoding?}])` publishes in one call. Staged: `begin_deploy(id, manifest: [{path, hash, size}])` returns `{uploadId, missingHashes}`; `add_files` stages only those; `finalize_deploy` publishes. Session TTL 15 minutes. |
| Versions and lifecycle | `rollback_canvas`, `unpublish_canvas`, `delete_version`, `archive_canvas`, `unarchive_canvas`, `delete_canvas` (owner), `transfer_canvas` (owner) | `rollback_canvas(id, version)` takes the `number` from `list_versions`. `delete_canvas` is a soft delete; only an admin can restore. `transfer_canvas(id, toUserId)` hands ownership to an existing editor; you stay on as an editor. |
| Settings | `update_canvas`, `set_capabilities`, `set_canvas_slug`, `set_canvas_preview`, `regenerate_deploy_key` | `update_canvas` covers `title`, `description` (max 2000 chars), `tags` (max 20, 50 chars each; one tag set drives list filters and the gallery), `access` rung, `discoverability`, `teamIds`, `password` (`null` clears), `sharedExpiresAt`, `spaFallback`, `previewMode`, `galleryListed`, `galleryTemplatable`, and the owner-only `guestAiEnabled` / `guestAiCap`. `set_capabilities(id, backendEnabled?, kv?, files?, ai?, realtime?, authoring?)` clears a `CAPABILITY_DISABLED` error. `set_canvas_slug` changes the URL at once (omit `slug` for a fresh random one). `regenerate_deploy_key` returns the new key once with a refreshed `deploy` block; the old key stops working. |
| People and sharing | `grant_access`, `invite_to_canvas`, `revoke_access`, `set_access_role` | The people list holds people and teams, each `viewer` or `editor`. `grant_access(id, email or teamId, role?)`: an existing user is granted at once; an admissible new email becomes a pending grant that materializes on first verified sign-in. Editors are org members only; guests are always viewers. |
| Draft loop | `get_draft`, `read_draft_file`, `write_draft_file`, `delete_draft_file`, `rename_draft_file`, `publish_draft`, `restore_draft` | The in-browser editor's model: edit one mutable draft, then `publish_draft` snapshots it as a version. Writes accept `expectedHash`; a mismatch fails with `DRAFT_CONFLICT` and reports the current hash. Use this when the user wants to stage edits without going live. |
| Teams | `list_teams`, `create_team`, `rename_team`, `delete_team`, `add_team_member`, `remove_team_member`, `cancel_team_invite`, `list_team_members` | Teams are grantable on a canvas's people list as viewers or editors. |

Typical flow: `create_canvas`, deploy (MCP or `curl`), then `get_canvas_file` or
`list_versions` to confirm.

**Verify through the server, not by fetching the URL.** The live URL is
access-controlled; an unauthenticated `GET` returns a login page, not your files.
Confirm a deploy with the returned `{version, fileCount}`, with `list_versions` (the
new version shows `current: true`), or with `get_canvas_file`.

Full reference: `{base}/docs/agents/mcp`.

## Deploy over HTTP

Base path: `{base}/v1/canvases/{id}`. `{id}` is the canvas id, not the slug. For this
API, `{base}` is the Deploy API host (`CANVAS_DROP_API_BASE_URL`, which defaults to
the instance base URL; operators set it only when the API is routed on a different
host than the canvases). The `deploy` block from `create_canvas` / `get_canvas` and
the dashboard's Deploy API section give the exact URLs.

Authenticate every call with the canvas's secret key: `Authorization: Bearer cd_…`.
The key is returned once at creation (dashboard, or MCP `create_canvas`) and can be
regenerated. It works only on its own canvas: a key for a different canvas returns
403, and a key whose canvas is archived, disabled, or deleted returns
`401 {"error":"unauthorized"}`.

Publish a ZIP (with `index.html` at its root), then read back what shipped:

```bash
curl -fsS -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
# → { "url", "version", "fileCount", "totalBytes", "warnings": [] }

curl -fsS "{base}/v1/canvases/{id}/files" \
  -H "Authorization: Bearer $CANVAS_KEY"
# → { "version", "fileCount", "files": [{ "path", "size", "mime", "hash" }] }
```

Limits: 100 MB per canvas, 25 MB per file, 2 000 files. Dotfiles are stripped;
zip-slip and zip-bomb archives are rejected. Deploy calls are rate-limited to 10 per
minute per canvas (`429 {"error":"rate_limited"}` with `Retry-After`).

### Staged upload for large or repeat deploys

Send a manifest, get back only the hashes the server does not already hold, stream
those blobs from disk, then finalize. Same engine as MCP `begin_deploy` / `add_files`
/ `finalize_deploy`.

```bash
# 1) Begin: a manifest of every file as { path, hash (sha256 hex), size }.
#    → { "uploadId", "missingHashes": [...] }
curl -fsS -X POST "{base}/v1/canvases/{id}/uploads" \
  -H "Authorization: Bearer $CANVAS_KEY" -H "Content-Type: application/json" \
  -d '{"manifest":[{"path":"index.html","hash":"<sha256>","size":123}]}'

# 2) Stage each missing blob's raw bytes. → 204. Repeat per hash.
curl -fsS -X PUT "{base}/v1/canvases/{id}/uploads/{uploadId}/blobs/<sha256>" \
  -H "Authorization: Bearer $CANVAS_KEY" --data-binary @index.html

# 3) Finalize → publishes a new live version. Single-use.
curl -fsS -X POST "{base}/v1/canvases/{id}/uploads/{uploadId}/finalize" \
  -H "Authorization: Bearer $CANVAS_KEY"
```

The session expires 15 minutes after `begin` (`UPLOAD_EXPIRED`). A blob whose hash is
not in the manifest is refused (`UPLOAD_UNEXPECTED_BLOB`); bytes that do not hash to
the URL's hash are refused (`BLOB_HASH_MISMATCH`); finalize fails with
`UPLOAD_MISSING_BLOB` if any manifest hash was never staged.

### Read back, roll back, unpublish

| Call | Returns |
|---|---|
| `GET {base}/v1/canvases/{id}` | `{id, slug, url, title, status, publicationState, currentVersionId}` |
| `GET {base}/v1/canvases/{id}/versions` | `{versions: [{number, source, status, createdBy, createdAt, fileCount, totalBytes, current}]}`, newest first, last 10 kept |
| `GET {base}/v1/canvases/{id}/files` | Live manifest `{version, fileCount, files[]}`; `404 NOT_PUBLISHED` when nothing is live |
| `GET {base}/v1/canvases/{id}/files?path=index.html` | That file's raw bytes (`ETag` is its sha256; pipe to `sha256sum` to confirm); `404 NOT_FOUND` for an unknown path |
| `POST {base}/v1/canvases/{id}/rollback` with `{"version": N}` | `{url, version}`; makes ready version `N` current. `400 {"error":"invalid_body"}` if `version` is missing or not a positive integer; `404 INVALID_PATH` if there is no ready version `N`; `409 VERSION_UNAVAILABLE` if a concurrent prune removed it (retry) |
| `POST {base}/v1/canvases/{id}/unpublish` (no body) | `{url, publicationState: "draft", currentVersionId: null}`; clears the live pointer and drops realtime sockets. `409 CANNOT_UNPUBLISH` when not published |

Deploy errors are JSON `{code, message, path?}`. `PUT …/deploy` answers 400 for every
validation failure (`EMPTY_DEPLOY`, `INVALID_ZIP`, `INVALID_PATH`, `TOO_MANY_FILES`,
`FILE_TOO_LARGE`, `CANVAS_TOO_LARGE`, `ZIP_SLIP_REJECTED`, `ZIP_BOMB_REJECTED`), and
`413 CANVAS_TOO_LARGE` when the body is over the cap before it is read. The staged
routes map size caps to 413, an unknown or foreign `uploadId` to
`404 UPLOAD_HANDLE_INVALID`, and `UPLOAD_ALREADY_FINALIZED` / `UPLOAD_IN_PROGRESS` to
409. The key cannot switch on capabilities; do that in the Backend tab or with
`set_capabilities`.

Full reference: `{base}/docs/api/deploy-api`.

## Add backend capability (browser SDK)

One tag defines the global `canvasdrop` (there is no `cd` alias and no `version`
property) and rides the viewer's session cookie. The slug and API origin are detected
from the page location, so the same file works in path mode (`{base}/c/{slug}/`) and
subdomain mode (`{slug}.canvases.example.com`). Every call goes to
`{apiBase}/v1/c/{slug}/...` with `credentials: "include"`.

```html
<script src="/sdk/v1.js"></script>
```

```js
// Identity: { id, email, name, avatarUrl, kind }; kind is "member" or "guest"
const me = await canvasdrop.me();

// KV: shared scope on canvasdrop.kv, per-viewer scope on canvasdrop.kv.user (same five methods)
await canvasdrop.kv.set("config", { theme: "dark" });   // any JSON value except null
const cfg = await canvasdrop.kv.get("config");           // null when absent
const n = await canvasdrop.kv.increment("votes");        // atomic; resolves to the new total
const page = await canvasdrop.kv.list({ prefix: "c", limit: 50 }); // { entries: [{ key, value }], nextCursor }
await canvasdrop.kv.delete("config");                    // idempotent
await canvasdrop.kv.user.set("pref", "dark");            // visible only to this viewer

// Files
const f = await canvasdrop.files.upload(fileObject);     // File → { id, name, size, url }
const files = await canvasdrop.files.list();             // [{ id, name, size, mime?, createdAt? }]
const src = canvasdrop.files.url(f.id);                  // synchronous absolute URL
await canvasdrop.files.delete(f.id);

// AI: model is required; the system prompt goes in options.system
const { text, usage, cost } = await canvasdrop.ai.chat(
  [{ role: "user", content: "Summarize this." }],
  { model: "claude-...", system: "Be terse.", maxTokens: 512 },
);
for await (const delta of canvasdrop.ai.stream(messages, { model })) {
  out.textContent += delta;                              // text chunks; stream() yields no usage/cost
}

// Realtime: one shared socket per page, one Channel object per name
const ch = canvasdrop.realtime.channel("room");
ch.subscribe((msg) => { /* { event, data, from: { id, name } } */ });
ch.publish("move", { x: 1 });                            // fire-and-forget
ch.onJoin((user) => {});                                 // also onLeave(user), onPresence(users)
const users = await ch.presence();                       // [{ id, name }]
ch.close();                                              // leave the channel
```

Signatures that trip agents up:

- AI is `chat(messages, options)` / `stream(messages, options)`. There is no
  `complete()`. `AiMessage.role` is `"user"` or `"assistant"` only. `options` is
  `{ model, system?, maxTokens? }`: no temperature, tools, or abort signal.
  `maxTokens` defaults to 1024 and is capped at 8192 server-side.
- `subscribe(handler)` returns `void`, not an unsubscribe function; `unsubscribe()`
  clears every handler on the channel. There is no generic `on(event, handler)`,
  `off`, or `once`.
- `kv.get` resolves to `null` for a missing key instead of throwing. `kv.set(key, null)`
  is rejected (`INVALID_BODY`); delete the key instead. `kv.list` pages 100 entries by
  default (max 1000) and returns `nextCursor` for the next page.
- `files.upload` takes a `File` and posts it as multipart field `file`. There is no
  progress callback.

Limits the server enforces: KV keys up to 512 bytes, values up to 64 KiB serialized,
10 000 shared keys and 1 000 per-user keys per canvas; files up to 25 MiB each and
1 GiB per canvas; AI calls 10 per minute per viewer, other runtime calls 120 per minute
per viewer per canvas; realtime 30 connections per canvas, 64 channels and 100
publishes per minute per connection, 16 KiB per frame.

The page-driven `canvasdrop.canvases.*` namespace (publish, update, list, revoke a
canvas from inside a canvas) sits behind the `authoring` capability, which is off by
default at both instance and canvas level. See `{base}/docs/sdk/authoring`.

## Errors

Every SDK failure throws a `CanvasdropError` with a stable `.code` string, a `.status`
number, and sometimes a `.hint` (a server remediation hint). Branch on `err.code`, not
the message.

| `.code` | status | when |
|---|---|---|
| `NOT_AUTHENTICATED` | 401 | viewer not signed in |
| `CAPABILITY_DISABLED` | 403 | Backend or the feature is off for this canvas; `.hint` says what to enable |
| `STATIC_ONLY` | 403 | public-link canvas; primitives refused for everyone but owner and editors |
| `PASSWORD_REQUIRED` | 403 | password-protected canvas and the gate has not been passed |
| `DISABLED` | 403 | canvas disabled by an administrator |
| `MODEL_NOT_ALLOWED` | 403 | AI model not in the instance allow-list |
| `GUEST_AI_DISABLED` | 403 | AI not enabled for guest viewers on this canvas |
| `CROSS_CANVAS_FORBIDDEN` | 403 | request came from another canvas's origin or page |
| `NOT_FOUND` | 404 | key, file, or canvas does not exist |
| `INVALID_BODY` | 400 | request body failed validation |
| `KEY_TOO_LARGE` / `VALUE_TOO_LARGE` | 413 | KV key / value over the limit |
| `FILE_TOO_LARGE` | 413 | uploaded file over the per-file limit |
| `KEY_LIMIT` | 409 | canvas hit its key-count limit |
| `NOT_NUMERIC` | 409 | `increment` on a non-numeric value |
| `QUOTA_EXCEEDED` | 429 / 409 | AI spend quota exceeded (429) or per-canvas file storage full (409) |
| `GUEST_AI_CAP` | 429 | guest AI spend cap reached |
| `RATE_LIMITED` | 429 | per-viewer request rate exceeded |
| `CONNECTION_LIMIT` | 429 | too many concurrent realtime connections |
| `AI_STREAM_TRUNCATED` / `AI_UPSTREAM_ERROR` | 502 | AI stream ended early / provider error |
| `REQUEST_FAILED` | 0 | failed with no specific code |

Typed subclasses (`instanceof` works): `NotAuthenticatedError` (any 401),
`CapabilityDisabledError` (403 with `CAPABILITY_DISABLED`; the capability name is in
the message, not a property), `NotFoundError` (any 404), `QuotaExceededError`
(`QUOTA_EXCEEDED`, `GUEST_AI_CAP`, `KEY_LIMIT`, `CONNECTION_LIMIT`, and every 413;
`.code` keeps the wire code), and `PublishFailedError` (authoring only). Everything
else, including `NOT_NUMERIC`, `STATIC_ONLY`, `PASSWORD_REQUIRED`, `DISABLED`,
`MODEL_NOT_ALLOWED`, and `RATE_LIMITED`, is a base `CanvasdropError` carrying the wire
`.code`. Client-side only codes: `DISCONNECTED` and `CHANNEL_CLOSED` (realtime),
`NO_STREAM` and `MALFORMED_FRAME` (AI stream).

Full table: `{base}/docs/api/errors`.

## More

- Docs: `{base}/docs`
- Agent quick reference: `{base}/llms.txt`
- `examples/poll.md` in this skill: a single-file poll on KV, with an optional
  realtime add-on.

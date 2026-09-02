---
name: canvas-drop
description: Deploy and extend small web artifacts ("canvases") on a canvas-drop instance. Use when the user wants to ship static HTML/JS to a shared URL, or give a canvas backend capability (KV, files, AI, identity, realtime, admin-granted Connections) through the zero-config browser SDK. Connect over MCP for an identity-scoped tool surface, or deploy over HTTP with a per-canvas key.
---

# canvas-drop

If you are an agent asked to put a static web artifact on a canvas-drop instance, or
to give one a backend, this skill is the contract: create a canvas, deploy it, verify
what shipped through the server, share it, and call the six fixed primitives (KV, files,
AI, identity, realtime, Connections) from the page. Nothing here needs a dashboard session: you
act over MCP as the signed-in user, or over HTTP with a per-canvas key.

`{base}` is the instance's base URL (a fresh local instance is `http://localhost:3000`).
Ask the user if you do not know it.

## Fastest path

1. `create_canvas` over MCP (`{base}/mcp`). It returns the canvas `id`, its `apiKey`
   (shown once), and a `deploy` block with the exact URLs to use.
2. Deploy a ZIP with `index.html` at its root:

   ```bash
   curl -fsS -X PUT "{base}/v1/canvases/{id}/deploy" \
     -H "Authorization: Bearer $CANVAS_KEY" --data-binary @site.zip
   # 200 {"url":"…","version":1,"fileCount":3,"totalBytes":12345,"warnings":[]}
   ```

3. Verify through the server: `get_canvas_file(id)` over MCP, or
   `GET {base}/v1/canvases/{id}/files` with the key. Do not fetch the canvas URL to
   check; it sits behind sign-in and returns a login page.

No shell? `deploy_canvas(id, files: [{path, content}])` over MCP publishes in one call.

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
  Backend behaviour comes only from the six fixed primitives.
- **Backend is off by default.** A built-in primitive call throws `CapabilityDisabledError`
  (`code: "CAPABILITY_DISABLED"`, status 403) until an owner or editor turns on Backend
  plus the specific feature (dashboard Backend tab, or `set_capabilities` over MCP).
  Identity (`me()`) has no separate toggle; it is on whenever Backend is on.
  Connections have no owner toggle: an admin creates and grants a profile, and Backend
  must still be on.
- **Deploy means live.** A deploy over the key API or the MCP deploy tools creates an
  immutable version and points the canvas at it in one step. The last 10 versions are
  kept; you can roll back to any of them.
- **Public link is static-only.** On a `public_link` canvas the primitives are refused
  for every viewer except the owner and editors (`STATIC_ONLY`, 403). Every other rung
  requires sign-in, and the primitives work for anyone who can open the canvas.
- **Roles.** A canvas has one owner; editors are owner-equivalent except delete,
  transfer, and the guest-AI fields. Viewers can open it but not manage it. A canvas
  you hold no role on reads as not found on every management surface.

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

The client runs an OAuth 2.1 sign-in once: the instance's normal login, then a
redirect back with a code (PKCE, dynamic client registration, no secret to copy).
Access tokens last one hour and the client refreshes them. Every call re-checks that
your account is active and re-resolves your role on the canvas, so a revoked grant
takes effect on the next call.

Every tool acts as you: a canvas you own or edit is in scope; a canvas you hold no
role on reads as `canvas not found`. Owner-only acts (`delete_canvas`,
`transfer_canvas`, the guest-AI fields of `update_canvas`) fail with `OWNER_ONLY` for
editors. An admin-disabled canvas is read-only: every mutation fails with
`DISABLED: …` until an admin re-enables it. Results are JSON text; failures are
`CODE: message` with `isError: true`. Canvas tools take the canvas `id`, never the
slug. Calls share one bucket of 120 per minute per user
(`429 {"error":"rate_limited"}` with `Retry-After`).

47 tools, grouped:

| Group | Tools | Notes |
|---|---|---|
| Identity and lists | `whoami`, `list_canvases`, `list_shared_canvases` | `list_canvases` takes `role` (`owned` / `edited`), `query` (case-, accent-, and whitespace-insensitive search over title, description, tags, and slug; multi-word AND), `tags` (any-match), `sort` (`updated` / `created` / `title` / `popular`), `limit` (default 50, max 100). Each row carries `owner` and `role`. |
| Create | `create_canvas`, `clone_canvas` | `create_canvas(title?, description?, backendEnabled?, slug?, orgId?)` returns the canvas, its `apiKey` (shown once), and a `deploy` block with the exact endpoints (`apiBase`, `zipUpload`, `staged.begin` / `stageBlob` / `finalize`, `readback`, and a copy-paste `curl`). Use them verbatim; do not probe for the API host. `get_canvas` returns the same block with a `$CANVAS_KEY` placeholder. `clone_canvas(id)` copies the published files into a new private, unpublished canvas; its key is not returned (use `regenerate_deploy_key`). |
| Read | `get_canvas`, `list_versions`, `get_canvas_file`, `get_canvas_usage`, `list_canvas_connections`, `list_access`, `search_people` | `get_canvas_file(id)` lists the live files; `get_canvas_file(id, path)` returns one file's content (`utf8` or `base64`; over 256 KiB comes back `truncated: true` without content). This is how you verify a deploy. `list_versions` rows carry a `downloadUrl` (ZIP export, same bearer token). `list_canvas_connections(id)` returns sanitized admin-granted profile metadata, never protected header values. `list_access` returns the people list with each entry's `id` (used by `revoke_access` / `set_access_role`) and, for the owner, `transferCandidates`. |
| Deploy | `deploy_canvas`, `begin_deploy`, `add_files`, `finalize_deploy` | `deploy_canvas(id, zipBase64)` or `deploy_canvas(id, files: [{path, content, encoding?}])` publishes in one call. Staged: `begin_deploy(id, manifest: [{path, hash, size}])` returns `{uploadId, missingHashes}`; `add_files` stages only those; `finalize_deploy` publishes. Session TTL 15 minutes. The canvas must be active (`NOT_ACTIVE` otherwise). |
| Versions and lifecycle | `rollback_canvas`, `unpublish_canvas`, `delete_version`, `archive_canvas`, `unarchive_canvas`, `delete_canvas` (owner), `transfer_canvas` (owner) | `rollback_canvas(id, version)` takes the `number` from `list_versions`. `delete_canvas` is a soft delete; only an admin can restore. `transfer_canvas(id, toUserId)` takes a user id from `list_access`'s `transferCandidates`, never an email; the recipient must already be an editor and an org member (`NOT_ELIGIBLE` otherwise). The result reports `previousOwnerEditor` (whether you were kept on as an editor) and `publicLinkReverted`. |
| Settings | `update_canvas`, `set_capabilities`, `set_canvas_slug`, `set_canvas_preview`, `regenerate_deploy_key` | `update_canvas` covers `title`, `description` (max 2000 chars), `tags` (max 20, 50 chars each; one tag set drives list filters and the gallery), `access` rung, `discoverability`, `teamIds`, `password` (`null` clears), `sharedExpiresAt`, `spaFallback`, `previewMode` (`auto` / `off`), `galleryListed`, `galleryTemplatable`, and the owner-only `guestAiEnabled` / `guestAiCap`. `set_canvas_preview(id, image)` uploads a custom cover (`previewMode: "custom"`); without `image` it reverts to `auto`. `set_capabilities(id, backendEnabled?, kv?, files?, ai?, realtime?, authoring?)` clears a `CAPABILITY_DISABLED` error. `set_canvas_slug` changes the URL at once (omit `slug` for a fresh random one). `regenerate_deploy_key` returns the new key once with a refreshed `deploy` block; the old key stops working, and the owner is emailed when an editor rotates it. |
| People and sharing | `grant_access`, `invite_to_canvas`, `revoke_access`, `set_access_role` | The people list holds people and teams, each `viewer` or `editor`. `grant_access(id, email or teamId, role?)`: an existing user is granted at once; an admissible new email becomes a pending grant that materializes on first verified sign-in. Only org members can be editors; guests are always viewers (`GUEST_VIEWER_ONLY`). |
| Draft loop | `get_draft`, `read_draft_file`, `write_draft_file`, `delete_draft_file`, `rename_draft_file`, `publish_draft`, `restore_draft` | The in-browser editor's model: edit one mutable draft, then `publish_draft` snapshots it as a version (`{version, versionId, fileCount, totalBytes}`). Writes accept `expectedHash`; a mismatch fails with `DRAFT_CONFLICT` and reports the current hash and last writer. `write_draft_file(…, create: true)` refuses an existing path (`PATH_EXISTS`). Use this when the user wants to stage edits without going live. |
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
zip-slip and zip-bomb archives are rejected. Deploy, staged begin/finalize, and
rollback share a throttle of 10 per minute per canvas (`429 {"error":"rate_limited"}`
with `Retry-After`).

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

The session expires 15 minutes after `begin` (`UPLOAD_EXPIRED`). A body that is not
JSON with a `manifest` array fails `400 INVALID_MANIFEST`. A blob whose hash is not in
the manifest is refused (`UPLOAD_UNEXPECTED_BLOB`); bytes that do not hash to the
URL's hash are refused (`BLOB_HASH_MISMATCH`); finalize fails with
`UPLOAD_MISSING_BLOB` if any manifest hash was never staged.

### Read back, roll back, unpublish

| Call | Returns |
|---|---|
| `GET {base}/v1/canvases/{id}` | `{id, slug, url, title, status, publicationState, currentVersionId}` |
| `GET {base}/v1/canvases/{id}/versions` | `{versions: [{number, source, status, createdBy, createdAt, fileCount, totalBytes, current}]}`, newest first, last 10 kept |
| `GET {base}/v1/canvases/{id}/files` | Live manifest `{version, fileCount, files[]}`; `404 NOT_PUBLISHED` when nothing is live |
| `GET {base}/v1/canvases/{id}/files?path=index.html` | That file's raw bytes (`ETag` is its sha256; pipe to `sha256sum` to confirm); `404 NOT_FOUND` for an unknown path |
| `POST {base}/v1/canvases/{id}/rollback` with `{"version": N}` | `{url, version}`; makes ready version `N` current. `400 {"error":"invalid_body"}` if `version` is missing or not a positive integer; `404 INVALID_PATH` if there is no ready version `N`; `409 VERSION_UNAVAILABLE` if a concurrent prune removed it (retry) |
| `POST {base}/v1/canvases/{id}/unpublish` (no body) | `{url, publicationState: "draft", currentVersionId: null}`; clears the live pointer and the share and gallery settings, and drops realtime sockets. `409 CANNOT_UNPUBLISH` when not published |

Deploy errors are JSON `{code, message, path?}`. `PUT …/deploy` answers 400 for every
validation failure (`EMPTY_DEPLOY`, `INVALID_ZIP`, `INVALID_PATH`, `TOO_MANY_FILES`,
`FILE_TOO_LARGE`, `CANVAS_TOO_LARGE`, `ZIP_SLIP_REJECTED`, `ZIP_BOMB_REJECTED`), and
`413 CANVAS_TOO_LARGE` when the body is over the cap before it is read. The staged
routes map the size caps (`CANVAS_TOO_LARGE`, `FILE_TOO_LARGE`, `TOO_MANY_FILES`) to
413, an unknown or foreign `uploadId` to `404 UPLOAD_HANDLE_INVALID`, and
`UPLOAD_ALREADY_FINALIZED` / `UPLOAD_IN_PROGRESS` to 409. The key cannot switch on
capabilities; do that in the Backend tab or with `set_capabilities`.

Full reference: `{base}/docs/api/deploy-api`.

## Add backend capability (browser SDK)

One tag defines the global `canvasdrop` (there is no `cd` alias and no `version`
property) and rides the viewer's session cookie. The slug and API origin are detected
from the page location, so the same file works in path mode (`{base}/c/{slug}/`) and
subdomain mode (`{slug}.canvases.example.com`); the root-relative `src` is served on
the canvas's own origin in both. Every call goes to `{apiBase}/v1/c/{slug}/...` with
`credentials: "include"`.

```html
<script src="/sdk/v1.js"></script>
```

```js
// Identity: { id, email, name, avatarUrl, kind }; kind is "member", or "guest" for a legacy guest session
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

// Connections: profile authority is created and granted by an administrator
const quote = await canvasdrop.connections.fetch(
  "stocks",
  `/v2/quote?symbol=${encodeURIComponent(symbol)}`,
  { headers: { accept: "application/json" } },
);
if (!quote.ok) throw new Error(`upstream ${quote.status}`); // upstream 4xx/5xx are Responses

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
ch.subscribe((msg) => { /* { event, data, from: { id, name } } */ });  // connects on first subscribe
ch.publish("move", { x: 1 });                            // fire-and-forget; buffered while reconnecting
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
  `off`, or `once`. The socket reconnects on its own (backoff from 500 ms to 10 s)
  except after a terminal close: capability off, signed out, or connection limit.
- `kv.get` resolves to `null` for a missing key instead of throwing. `kv.set(key, null)`
  is rejected (`INVALID_BODY`); delete the key instead. `kv.list` pages 100 entries by
  default (max 1000) and returns `nextCursor` for the next page.
- `files.upload` takes a `File` and posts it as multipart field `file`. There is no
  progress callback.
- `connections.fetch(profile, path, init?)` requires a root-relative path and an
  admin-granted profile. The admin fixes one exact HTTPS origin, allowed methods, and
  write-only protected headers; canvas code cannot change them. Platform policy failures
  throw, while approved upstream 4xx/5xx resolve as native `Response` objects.

Limits the server enforces: KV keys up to 512 bytes, values up to 64 KiB serialized,
10 000 shared keys and 1 000 per-user keys per canvas; files up to 25 MiB each and
1 GiB per canvas; AI calls 10 per minute per viewer, other runtime calls 120 per minute
per viewer per canvas; realtime 30 connections per canvas, 64 channels and 100
publishes per minute per connection, 16 KiB per frame; Connections default to 256 KiB
request bodies, 2 MiB responses, 10 seconds total, 5 in flight per canvas, and 60 calls
per minute per actor + canvas + profile.

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
| `CROSS_CANVAS_FORBIDDEN` / `CROSS_SITE_FORBIDDEN` | 403 | request came from another canvas's origin or page (subdomain / path mode) |
| `NOT_FOUND` | 404 | key, file, or canvas does not exist; also a canvas the viewer cannot open (private, archived, or share expired) |
| `INVALID_BODY` | 400 | request body failed validation |
| `KEY_TOO_LARGE` / `VALUE_TOO_LARGE` | 413 | KV key / value over the limit |
| `FILE_TOO_LARGE` | 413 | uploaded file over the per-file limit |
| `KEY_LIMIT` | 409 | canvas hit its key-count limit |
| `NOT_NUMERIC` | 409 | `increment` on a non-numeric value |
| `QUOTA_EXCEEDED` | 429 / 409 | AI spend quota exceeded (429) or per-canvas file storage full (409) |
| `GUEST_AI_CAP` | 429 | guest AI spend cap reached |
| `RATE_LIMITED` | 429 | per-viewer request rate exceeded |
| `CONNECTION_LIMIT` | 429 | too many concurrent realtime or outbound connections |
| `CONNECTION_NOT_GRANTED` | 404 | the requested Connection profile is not granted to this canvas |
| `CONNECTION_DISABLED` / `CONNECTION_KEY_UNAVAILABLE` | 503 | the admin profile is disabled or its external encryption key is unavailable |
| `METHOD_NOT_ALLOWED` | 405 | the HTTP method is not approved for the profile |
| `DESTINATION_BLOCKED` | 403 | origin, DNS, redirect, or encoding crossed the Connection boundary |
| `REQUEST_TOO_LARGE` / `RESPONSE_TOO_LARGE` | 413 / 502 | a Connection request or response exceeded its bound |
| `CONNECTION_RATE_LIMIT` | 429 | a Connection-specific rate bucket is spent |
| `UPSTREAM_TIMEOUT` / `UPSTREAM_UNAVAILABLE` | 504 / 502 | approved upstream timed out or failed |
| `AI_STREAM_TRUNCATED` / `AI_UPSTREAM_ERROR` | 502 | AI stream ended early / provider error |
| `REQUEST_FAILED` | 0 | failed with no specific code |

Typed subclasses (`instanceof` works): `NotAuthenticatedError` (any 401),
`CapabilityDisabledError` (403 with `CAPABILITY_DISABLED`; no capability property,
and the message is the server's `.hint`), `NotFoundError` (every 404 except
`CONNECTION_NOT_GRANTED`, which preserves its code on the base error),
`QuotaExceededError` (`QUOTA_EXCEEDED`, `GUEST_AI_CAP`, `KEY_LIMIT`,
`CONNECTION_LIMIT`, and every 413; `.code` keeps the wire code), and
`PublishFailedError` (authoring only; `.id` is the created canvas). Everything else,
including `NOT_NUMERIC`, `STATIC_ONLY`, `PASSWORD_REQUIRED`, `DISABLED`,
`MODEL_NOT_ALLOWED`, and `RATE_LIMITED`, is a base `CanvasdropError` carrying the wire
`.code`. Client-side only codes: `DISCONNECTED` and `CHANNEL_CLOSED` (realtime),
`NO_STREAM` and `MALFORMED_FRAME` (AI stream).

Full table: `{base}/docs/api/errors`.

## More

- Docs: `{base}/docs`
- Agent quick reference: `{base}/llms.txt`
- `examples/poll.md` in this skill: a single-file poll on KV, with an optional
  realtime add-on.

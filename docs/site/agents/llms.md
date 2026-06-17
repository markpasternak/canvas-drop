# llms.txt

If you are an agent deploying a canvas, start here. canvas-drop serves a single
plain-text contract at [`{base}/llms.txt`](/llms.txt) — no markup chrome,
designed to be dropped straight into context. It is **public** (served from the
docs band, readable without a session) so you can learn the API before you hold
credentials.

## Deploy in two steps

1. **Get a per-canvas API key** — the canvas owner creates the canvas in the
   dashboard (the `api` create method mints the canvas plus a one-time secret
   key) and hands you that key, shown once.
2. **Push your artifact** with the Bearer key and a ZIP body:

   ```
   PUT {base}/v1/canvases/{id}/deploy
   Authorization: Bearer <secret-key>
   Content-Type: application/zip
   ```

   This publishes a new live version directly — no draft loop. Read-back and
   companion routes: `GET /v1/canvases/{id}`, `GET /v1/canvases/{id}/versions`,
   `GET /v1/canvases/{id}/files`, `POST /v1/canvases/{id}/rollback`,
   `POST /v1/canvases/{id}/unpublish`. For large or repeat deploys, the staged
   content-addressed flow (`POST /uploads` → `PUT /uploads/{uploadId}/blobs/{hash}`
   → `POST /uploads/{uploadId}/finalize`) sends only changed blobs. See the
   [Deploy API](/docs/api/deploy-api).

`{base}` is the instance origin. The key is verified per-canvas; it only
deploys to the one canvas it belongs to.

## Connect over MCP (no key to paste)

If your host speaks the Model Context Protocol, add `{base}/mcp` instead of handling
keys. You sign in once through the instance's normal org login (OAuth, with automatic
client registration) and then get identity-scoped tools across every canvas you own:
`whoami`, `list_canvases`, `create_canvas`, `get_canvas`, `list_versions`,
`deploy_canvas`, `begin_deploy`/`add_files`/`finalize_deploy`, `get_canvas_file`,
`rollback_canvas`, `unpublish_canvas`, plus the full management surface
(`update_canvas` settings/sharing/`previewMode`, `set_canvas_preview` custom cover,
`set_capabilities`, `set_canvas_slug`,
`regenerate_deploy_key`, `archive_canvas`/`unarchive_canvas`, `delete_canvas`,
`clone_canvas`, `get_canvas_usage`, the access tools `list_access`/`grant_access`/
`resend_guest_invite`/`revoke_access`, and the editor draft loop `get_draft`/
`read_draft_file`/`write_draft_file`/`delete_draft_file`/`rename_draft_file`/
`publish_draft`/`restore_draft`). The MCP is at **full parity with the dashboard** —
anything an owner can do in the UI, an agent can do here. The full table is in the
[MCP server](/docs/agents/mcp) reference. A tool only touches canvases you own. Typical
flow: `create_canvas` then `deploy_canvas`. Every deploy **publishes immediately** (no
draft step). The live URL is **access-controlled** (org sign-in), so don't verify a
deploy by fetching it — an unauthenticated GET returns a login page. Verify through the
server: the returned `{version, fileCount}`, `list_versions`, or `get_canvas_file`
(reads back the live files/content). **Strongly prefer `curl` for the file transfer** —
the MCP deploy tools inline bytes into the model, so when you can run shell commands,
`curl` the staged Deploy API and PUT each blob's raw bytes instead (ask for command
permission if needed). Reserve MCP deploys for a small first publish without shell
access. `create_canvas` returns a `deploy` block with the exact curl endpoints (incl. a
`readback` URL) so you never probe for the API host. Use the `readback` URL from
that block to confirm the live files, or call `get_canvas_file` (no `path` lists the
manifest; a `path` reads back content, capped at 256 KiB). Full reference:
[MCP server](/docs/agents/mcp).

## Backend capability: the browser SDK

Inside a canvas, load the zero-config SDK — no keys in page code; identity rides
the session cookie:

```html
<script src="/sdk/v1.js"></script>
```

It exposes one global, **`canvasdrop`** (there is no `cd` alias). Mode and slug
are auto-detected from the canvas URL; every call hits
`{apiBase}/v1/c/{slug}/...` with the session cookie.

- `canvasdrop.me()` → `{ id, email, name, avatarUrl, kind }` where `kind` is
  `"member"` (an org user) or `"guest"` (an email-invited viewer).
- `canvasdrop.kv` and `canvasdrop.kv.user` — `get(key)` → value or `null`,
  `set(key, value)`, `delete(key)`, `list({ prefix?, cursor?, limit? })` →
  `{ entries, nextCursor }`, `increment(key, by = 1)` → number. `kv.user` is
  per-viewer, the root scope is shared.
- `canvasdrop.files` — `upload(file)` → `{ id, name, size, url }`, `list()`,
  `delete(id)`, `url(id)` (synchronous; returns the content URL).
- `canvasdrop.ai` — `chat(messages, { model })` → `{ text, usage, cost }`, and
  `stream(messages, { model })` → `AsyncIterable<string>` (SSE; the provider key
  is server-side only). `model` is required.
- `canvasdrop.realtime.channel(name)` — `publish(event, data)`,
  `subscribe(handler)`, `unsubscribe()`, `presence()`, `onPresence`, `onJoin`,
  `onLeave`, `close()`. There is no generic `.on(...)`.

Full signatures and types: [SDK overview](/docs/sdk/overview).

## Sharing & access

Sharing is one **access rung** per canvas, set by the owner from the dashboard's
Share tab (or its session-authenticated management API). The rung is one of:

- `private` — owner only.
- `specific_people` — a named allowlist of org members and/or email-invited
  guests.
- `whole_org` — any authenticated org member with the link.
- `public_link` — anyone with the link. Admin-gated per owner account
  (`canPublishPublic`), and **static-only** for non-owners: every backend
  primitive is refused, returning `403 STATIC_ONLY`.

Invited guests get KV, files, and realtime; **AI is opt-in per canvas** with a
USD spend cap (`guestAiEnabled` / `guestAiCap`). The full model — guest
magic-link invites, password locks, share expiry — is in
[Sharing & access](/docs/authoring/sharing).

## Capabilities and errors

A canvas must opt into **backend** (off by default); then `kv`, `files`, `ai`,
and `realtime` toggle independently. Identity (`me()`) is on whenever backend
is. AI also requires a configured provider key and realtime an enabled operator
global. A disabled feature returns `403 CAPABILITY_DISABLED`.

Errors are machine-readable: every failure carries a stable string `.code`
(e.g. `NOT_AUTHENTICATED` (401), `NOT_FOUND` (404), `CROSS_CANVAS_FORBIDDEN`
(403), `STATIC_ONLY` (403), `MODEL_NOT_ALLOWED` (403), `QUOTA_EXCEEDED` (429),
`VALUE_TOO_LARGE` (413)). In the browser SDK every error is a `CanvasdropError`
with that `.code`; four codes also have dedicated subclasses —
`NotAuthenticatedError`, `NotFoundError`, `CapabilityDisabledError`,
`QuotaExceededError`. Branch on `.code`, not on message text.

For a packaged, installable version of this guidance, see the
[Agent skill](/docs/agents/skill).

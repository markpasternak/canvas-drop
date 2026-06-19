---
name: canvas-drop
description: Deploy and extend small web artifacts ("canvases") on a canvas-drop instance. Use when the user wants to ship static HTML/JS to a shared URL, or give a canvas backend capability (key-value, files, identity, AI, realtime) via the zero-config browser SDK. Connect over MCP for an identity-scoped, multi-tool surface, or deploy over HTTP with a per-canvas key.
---

# canvas-drop

canvas-drop hosts small static web artifacts ("canvases") at shared URLs and gives
them backend capability through a zero-config browser SDK. You can deploy a canvas
over HTTP with a per-canvas API key — no human and no dashboard session required.

Replace `{base}` below with the instance's base URL (ask the user if unknown).

## When to use this skill

- The user wants to publish an HTML/JS prototype, dashboard, demo, or small tool
  to a URL their colleagues can open.
- The user wants a canvas to persist data, store files, read the signed-in viewer,
  call an AI model, or sync in realtime — without managing a backend.

## Golden rules

- **Never put a secret in canvas files.** No API keys, provider keys, or tokens in
  the HTML/JS you deploy. Identity rides the signed-in session cookie; the per-canvas
  API key is used only by the deploy tool, never shipped into the canvas.
- **Static only.** A canvas is plain files — no server build step. AI-generated
  HTML runs unmodified.
- **Capabilities are off until enabled.** A backend method throws
  `CapabilityDisabledError` (`.code` `CAPABILITY_DISABLED`, 403) until the canvas
  owner enables the **Backend** master switch plus the feature in the **Backend** tab.
  Identity (`me()`) has no separate toggle — it is on whenever Backend is on.

## Two ways to act on canvases

- **Deploy over HTTP with `curl` (strongly preferred for shipping files).** This is the
  default path whenever you can run shell commands — **request command/network
  permission if you don't have it rather than falling back.** `curl` streams file bytes
  straight from disk to the server, so they never pass through your context: far cheaper,
  no payload-size ceiling, and the same content-addressed staging the MCP uses. See
  *Deploy a canvas (HTTP)* below.
- **Connect over MCP (control plane + when you truly can't run commands).** One connect,
  no key to paste — identity-scoped tools across all your canvases. Great for create /
  list / rollback / **verify** (`get_canvas_file`), and acceptable for a *small first
  deploy* when shell access isn't available — but note every MCP deploy tool inlines file
  bytes into the model, so prefer `curl` for the actual file transfer.

## Connect over MCP

If your agent host speaks MCP (Claude, ChatGPT, …), add the instance's MCP endpoint:

```
{base}/mcp
```

The client walks an OAuth sign-in once (your normal org login + a consent screen) —
**no secret to copy**. Once connected you have these tools, each scoped to your
account and the canvases you own:

- `whoami` — the connected account.
- `create_canvas` — make a canvas; returns its id, URL, a one-time deploy key, AND a
  `deploy` block with the **exact, ready-to-run curl endpoints** (`apiBase`, `zipUpload`,
  staged URLs, `readback`, and a copy-paste `curl` command with the key embedded). Use
  these verbatim — do not probe for the API host. `get_canvas` returns the same endpoints
  (with a `$CANVAS_KEY` placeholder) for an existing canvas.
- `list_canvases` — the canvases you own. Optional `query` (a forgiving text search
  over title, description, tags, and slug — case/accent/whitespace-insensitive, multi-word
  AND) and `tags` (any-match — canvases carrying any of the given tags) filters.
- `get_canvas` / `list_versions` — current state and version history.
- `deploy_canvas` — publish static files (a base64 ZIP, or a `files` array) directly to
  live in one call. Best for a **first publish of a small canvas**.
- `begin_deploy` / `add_files` / `finalize_deploy` — staged upload: send a manifest,
  get back only the hashes you still need to send, stage those, then publish. Prefer
  this for **any re-deploy** or a canvas with **many / large / binary files**.
- `get_canvas_file` — read back what's **live** (list files, or fetch one file's
  content). This is how you **verify a deploy** — see below.
- `rollback_canvas` — point the canvas back at an earlier version number.
- `unpublish_canvas` — take a published canvas back to draft.
- `set_capabilities` — toggle the Backend master switch and the kv/files/ai/realtime
  features (same as the dashboard Backend tab). Use this to clear a `CAPABILITY_DISABLED`
  error.
- `set_canvas_slug` — change the URL slug (pass one, or omit for a fresh random slug);
  the old URL stops working immediately.
- `regenerate_deploy_key` — mint a new `cd_…` deploy key and invalidate the old one
  (key leaked or lost). Returns the key once, with a refreshed `deploy` block.
- `archive_canvas` / `unarchive_canvas` — take a canvas offline (reversible); restore it.
- `delete_canvas` — soft-delete a canvas (not reversible from MCP; a canvas an admin has
  DISABLED can't be deleted).
- `update_canvas` — settings + sharing (Settings/Share tabs): title, the single
  `description` (max 2000 chars, shown in Overview, the gallery, and grid cards), access
  rung, password (or clear), share expiry, SPA fallback, `previewMode`, gallery listing,
  and `tags` — one unified tag set per canvas (max 20, ≤50 chars each) that powers both
  owner-list filtering and public gallery display (there is no separate "gallery summary"
  or "gallery tags").
- `list_access` / `grant_access` / `resend_guest_invite` / `revoke_access` — the
  per-canvas allowlist for the `specific_people` rung: list members + guests, add a member
  or email-invite a guest, re-send, or remove.
- `clone_canvas` — clone an owned canvas (or a shared gallery template) into a new draft.
- `get_canvas_usage` — view + op/storage/AI usage stats.
- `get_draft` / `read_draft_file` / `write_draft_file` / `delete_draft_file` /
  `rename_draft_file` / `publish_draft` / `restore_draft` — the in-browser editor's draft
  loop: edit a mutable draft, then publish it as a version (or restore an old version into it).

These tools cover what an owner does in the dashboard — create, deploy, version, settings,
sharing, gallery, capabilities, clone, usage, and the full draft/publish editor loop. Every
tool acts only on canvases you own (`clone_canvas` also reaches a shared gallery template);
a canvas you don't own reads as **canvas not found** (no existence leak).
Typical flow: `create_canvas` → `deploy_canvas` with your files, all in one session.
If an admin has disabled a canvas (moderation takedown) it goes **read-only**: reads
still work, but every mutation tool fails with `DISABLED: <reason>` until an admin
re-enables it.

**Every deploy publishes immediately** — there is no draft step over MCP; the files go
**live** at once (kept as an immutable version). The live URL is **access-controlled**
(default: org sign-in), so it is not an anonymous public link.

**Verify through the server, not by fetching the URL.** An unauthenticated `GET` of the
live URL returns a login page, not your files. Confirm a deploy with the returned
`{version, fileCount}`, `list_versions` (the new version shows as `current`), or
`get_canvas_file` (reads back the live files/content; pass a `path` like `index.html`).

**Prefer `curl` for the file transfer.** The MCP deploy tools (`deploy_canvas`,
`add_files`) inline file bytes into the tool call — they pass through the model. If you
can run shell commands, deploy over the HTTP Deploy API with `curl` instead (below), and
**ask for command permission if you need it** rather than inlining bytes. Reserve the MCP
deploy tools for a small first publish when shell access truly isn't available.

See [`{base}/docs/agents/mcp`]({base}/docs/agents/mcp) for the full reference.

## Deploy a canvas (HTTP) — the preferred path

This is the path to use whenever you can run shell commands: bytes stream from disk and
never enter your context. If `curl` or outbound requests aren't permitted yet, **ask for
that permission** before falling back to an MCP deploy tool.

The deploy API publishes a version directly to live (no draft loop). You need the
canvas `id` and its per-canvas secret key, both from the dashboard create flow (the
key is shown once at creation; an owner can regenerate it). Over MCP, `create_canvas`
returns the same key.

Send a ZIP archive (with `index.html` at the root) as the request body:

```bash
curl -X PUT "{base}/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
```

This `deploy` publishes **immediately** to live (no draft loop). The canvas URL is
access-controlled, so **don't verify by fetching it** — an unauthenticated `GET` returns
a login page. Confirm with `GET {base}/v1/canvases/{id}` (current state + version) or
`GET {base}/v1/canvases/{id}/versions`.

For many / large / binary files, use the **staged upload** instead of one big ZIP — the
bytes stream straight from disk and the server only asks for blobs it doesn't already
have:

```bash
# 1) Open a session with the manifest of {path, hash (sha256 hex), size}.
#    Response: { uploadId, missingHashes } — only the blobs not already stored.
curl -X POST "{base}/v1/canvases/{id}/uploads" \
  -H "Authorization: Bearer $CANVAS_KEY" -H "Content-Type: application/json" \
  -d '{"manifest":[{"path":"index.html","hash":"<sha256>","size":123}]}'
# 2) PUT each missing blob's raw bytes (never buffered into an agent's context).
#    Each returns 204. Callable repeatedly to chunk large uploads.
curl -X PUT "{base}/v1/canvases/{id}/uploads/{uploadId}/blobs/<sha256>" \
  -H "Authorization: Bearer $CANVAS_KEY" --data-binary @index.html
# 3) Finalize → publishes a new live version (fails if any manifest blob is missing).
curl -X POST "{base}/v1/canvases/{id}/uploads/{uploadId}/finalize" \
  -H "Authorization: Bearer $CANVAS_KEY"
```

`{base}` is the instance's **API host**, which in subdomain mode is usually a dedicated
host (e.g. `https://api.example.com`), NOT the per-canvas host. Don't probe for it:
`create_canvas` hands you the exact endpoints in its `deploy` block (and the dashboard
create flow shows them), so use those verbatim.

The key is verified per-canvas. Companion deploy-API operations (same Bearer auth):

- `GET {base}/v1/canvases/{id}` — current state
- `GET {base}/v1/canvases/{id}/versions` — version history (last 10 kept)
- `GET {base}/v1/canvases/{id}/files` — **verify a deploy**: read back the live version.
  No query → JSON manifest (`{version, fileCount, files:[{path,size,mime,hash}]}`);
  `?path=index.html` → that file's raw bytes (pipe to `sha256sum` to confirm). The live
  canvas URL is sign-in gated, so this is how a curl agent checks what actually shipped.
- `POST {base}/v1/canvases/{id}/rollback` with JSON body `{"version": N}` — sets the
  live pointer to ready version N (find N via the `/versions` list, where each entry
  has a `number`). A missing/non-number `version` returns `400 INVALID_PATH`; an
  unknown or non-ready version returns `404 INVALID_PATH`; a version removed by a
  concurrent prune returns `409 VERSION_UNAVAILABLE` (retry).
- `POST {base}/v1/canvases/{id}/unpublish` (no body) — takes a published canvas back
  to Draft (clears the live pointer, drops sockets). `409 CANNOT_UNPUBLISH` if it
  isn't currently published.

A deploy-API key only works while the canvas is active; if the canvas is archived or
disabled, the key is not recognized and the request returns 401 unauthorized. (The 409
`NOT_ACTIVE` code is dashboard-only; a disabled canvas surfaces as `DISABLED` (403) on
the runtime API.)

## Add backend capability (browser SDK)

Add one tag — it defines the global `canvasdrop` (no `cd` alias) and rides the
session cookie. The bundle and slug/origin are auto-detected from the page location,
so the same file works in both path and subdomain URL modes:

```html
<script src="/sdk/v1.js"></script>
```

```js
// Identity — { id, email, name, avatarUrl, kind }; kind is "member" or "guest"
const me = await canvasdrop.me();

// KV (shared scope) + kv.user (per-viewer scope) — same five methods on each
await canvasdrop.kv.set("config", { theme: "dark" });
const cfg = await canvasdrop.kv.get("config");        // null if absent
const n = await canvasdrop.kv.increment("votes");     // atomic; returns new number
const page = await canvasdrop.kv.list({ prefix: "c", limit: 50 });
await canvasdrop.kv.user.set("pref", "dark");         // scoped to the viewer

// Files — upload(file: File) returns { id, name, size, url }
const f = await canvasdrop.files.upload(fileObject);
const files = await canvasdrop.files.list();          // [{ id, name, size, mime?, createdAt? }]
const src = canvasdrop.files.url(f.id);               // synchronous absolute URL
await canvasdrop.files.delete(f.id);

// AI — model is required; returns { text, usage, cost }
const { text } = await canvasdrop.ai.chat(
  [{ role: "user", content: "Summarize this." }],
  { model: "claude-...", system: "Be terse.", maxTokens: 512 },
);
for await (const delta of canvasdrop.ai.stream(messages, { model })) {
  // delta is a text chunk
}

// Realtime — one channel object per name
const ch = canvasdrop.realtime.channel("room");
ch.subscribe((msg) => { /* { event, data, from } */ });
ch.publish("move", { x: 1 });
ch.onJoin((user) => {});                              // also onLeave, onPresence
const users = await ch.presence();                   // [{ id, name }]
```

Notes on signatures (these differ from older docs):

- AI is `chat(messages, options)` / `stream(messages, options)` — there is **no**
  `complete()`. `AiMessage.role` is `"user"` or `"assistant"` only; the system
  prompt goes in `options.system`.
- `realtime.channel().subscribe(handler)` takes the message handler. Listeners are
  the specific `subscribe` / `onPresence` / `onJoin` / `onLeave` — there is no
  generic `on(event, handler)`.
- All SDK requests go to `{apiBase}/v1/c/{slug}/...` with `credentials: "include"`.

## Errors

Every failure throws a `CanvasdropError` with a stable `.code` string and `.status`
number. Branch on `err.code`. Common codes:

| `.code` | status | when |
|---|---|---|
| `NOT_AUTHENTICATED` | 401 | viewer not signed in |
| `CAPABILITY_DISABLED` | 403 | Backend or the feature is off for this canvas |
| `MODEL_NOT_ALLOWED` | 403 | AI model not in the instance allow-list |
| `NOT_FOUND` | 404 | key, file, or canvas does not exist |
| `INVALID_BODY` | 400 | request body failed validation |
| `VALUE_TOO_LARGE` / `KEY_TOO_LARGE` | 413 | KV value / KV key over limit |
| `FILE_TOO_LARGE` | 413 | uploaded file over the per-file size limit |
| `KEY_LIMIT` | 409 | canvas hit its key-count limit |
| `NOT_NUMERIC` | 409 | `increment` on a non-numeric value |
| `QUOTA_EXCEEDED` | 429 | spend or rate quota exceeded |
| `CONNECTION_LIMIT` | 429 | too many concurrent realtime connections |
| `AI_STREAM_TRUNCATED` / `AI_UPSTREAM_ERROR` | 502 | AI stream ended early / provider error |
| `REQUEST_FAILED` | 0 | request failed with no specific code |

Typed subclasses with `instanceof` support: `CapabilityDisabledError`,
`QuotaExceededError`, `NotFoundError`, `NotAuthenticatedError`. Note that any 409 or
413 response maps to `QuotaExceededError` — so `KEY_LIMIT`, `NOT_NUMERIC` (409), and
`VALUE_TOO_LARGE` / `KEY_TOO_LARGE` / `FILE_TOO_LARGE` (413) are surfaced as `QuotaExceededError` (with
the wire `.code` intact). Only codes outside the typed-subclass mapping fall through to
the base `CanvasdropError` carrying the wire `.code`.

## More

- Full docs: `{base}/docs`
- Agent quick reference: `{base}/llms.txt`
- See `examples/` in this skill for runnable snippets.

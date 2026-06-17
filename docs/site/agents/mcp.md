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
server, registers itself automatically (Dynamic Client Registration), and opens a
browser to **this instance's normal login** (the same org sign-in you use for the
dashboard) followed by a consent screen. No second account, no secret to copy. The
client stores the resulting token and refreshes it automatically.

Identity always comes from that sign-in, server-side — never from anything the client
asserts. Only members whose email is allowed to sign in can connect.

## Tools

Every tool is scoped to your account. A canvas you don't own reads as *not found* —
there is no cross-owner access and no existence leak.

| Tool | What it does |
|---|---|
| `whoami` | The connected account (`id`, `email`, `name`). |
| `list_canvases` | The canvases you own. |
| `create_canvas` | Create a canvas; returns its id, URL, a one-time deploy key, and a `deploy` block of ready-to-run curl endpoints (so you never probe for the API host). |
| `get_canvas` | Current state of a canvas you own. |
| `list_versions` | Published version history of a canvas you own. |
| `deploy_canvas` | Publish static files directly to live in one call — pass either a base64-encoded ZIP (`zipBase64`) **or** a `files` array (text as UTF-8, binary as base64). |
| `begin_deploy` | Open a staged upload from a file manifest (path, sha256, size); returns an `uploadId` and the subset of hashes you still need to send. |
| `add_files` | Stage files into an open upload (text as UTF-8, binary as base64); call repeatedly to chunk a large set. |
| `finalize_deploy` | Publish a new version from a staged upload. Single-use. |
| `get_canvas_file` | Read back what's **live**: list the current version's files, or fetch one file's content. Use it to **verify a deploy** (the live URL is sign-in gated — see below). |
| `rollback_canvas` | Point a canvas back at an earlier version number. |
| `unpublish_canvas` | Take a published canvas back to draft. |
| `set_capabilities` | Toggle a canvas's backend capabilities — `backendEnabled` is the master switch; `kv`/`files`/`ai`/`realtime` are individual features (effective only when backend is on). Omitted fields are unchanged. |
| `set_canvas_slug` | Change a canvas's URL slug (pass a custom one, or omit for a fresh random slug). The old URL stops working immediately. |
| `regenerate_deploy_key` | Mint a new `cd_…` deploy key and invalidate the old one; the new key is returned **once**. |
| `archive_canvas` | Archive a canvas (reversible) — takes its URL offline and revokes guest grants. |
| `unarchive_canvas` | Restore an archived canvas back to active. |
| `delete_canvas` | Soft-delete a canvas — it loses its URL and is purged after the retention window. Blocked if an admin has disabled the canvas. Not reversible from MCP. |

A typical session is `create_canvas` followed by `deploy_canvas` with your files — the
canvas is live in one round trip, and no per-canvas key is ever handled by the agent.

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

Tool calls are rate-limited per account and recorded in the audit log alongside every
other deploy and lifecycle event.

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

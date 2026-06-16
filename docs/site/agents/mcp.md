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
| `create_canvas` | Create a canvas; returns its id, URL, and a one-time deploy key. |
| `get_canvas` | Current state of a canvas you own. |
| `list_versions` | Published version history of a canvas you own. |
| `deploy_canvas` | Publish static files directly to live in one call — pass either a base64-encoded ZIP (`zipBase64`) **or** a `files` array (text as UTF-8, binary as base64). |
| `begin_deploy` | Open a staged upload from a file manifest (path, sha256, size); returns an `uploadId` and the subset of hashes you still need to send. |
| `add_files` | Stage files into an open upload (text as UTF-8, binary as base64); call repeatedly to chunk a large set. |
| `finalize_deploy` | Publish a new version from a staged upload. Single-use. |
| `rollback_canvas` | Point a canvas back at an earlier version number. |
| `unpublish_canvas` | Take a published canvas back to draft. |

A typical session is `create_canvas` followed by `deploy_canvas` with your files — the
canvas is live in one round trip, and no per-canvas key is ever handled by the agent.

### Staged uploads (large or incremental)

`deploy_canvas` is the one-call path for small canvases. For large or
frequently-re-deployed canvases, the staged flow keeps file bytes out of the
model's context and only uploads what changed:

1. **`begin_deploy`** with the full manifest (`path`, `hash` = sha256 of the
   bytes, `size`). The server replies with `missingHashes` — the blobs it doesn't
   already have (content-addressed, so an unchanged file is never re-sent).
2. **`add_files`** the contents for those hashes, in as many calls as you like.
3. **`finalize_deploy`** to publish. The handle is single-use and short-lived; a
   finalize that's missing a blob fails cleanly and can be retried after staging it.

The same staging flow is available over plain HTTP on the keyed
[Deploy API](/docs/api/deploy-api) for agents that can `curl` directly.

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

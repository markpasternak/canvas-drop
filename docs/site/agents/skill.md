# Agent skill

Install this skill so your coding agent can create, deploy, verify, and extend
canvases on this instance first try. It is a standard skill package: a `SKILL.md`
whose `name` / `description` frontmatter carries the when-to-use trigger, so an
agent host that discovers skills loads it on its own when a task matches. `{base}`
below is the instance origin (a fresh local instance is `http://localhost:3000`).

## Install

`GET {base}/skill.zip` is public. No session, cookie, or API key is required, so an
agent fetches, unpacks, and checks it in three commands:

```bash
curl -fL "{base}/skill.zip" -o canvas-drop-skill.zip
unzip -o canvas-drop-skill.zip -d ~/.claude/skills/
ls ~/.claude/skills/canvas-drop
# SKILL.md  examples
```

The archive unpacks to one folder:

```
canvas-drop/
  SKILL.md          # frontmatter: name: canvas-drop, description: <when to use>
  examples/poll.md  # a single-file poll on KV, with an optional realtime add-on
```

The command above uses Claude Code's per-user skills directory; a `.claude/skills/`
folder inside a repo scopes the skill to that project. For any other host, drop the
`canvas-drop/` folder wherever it discovers skills, or point the agent at the
unpacked `SKILL.md` directly. The skill carries no instance-specific configuration:
it refers to the instance as `{base}` and asks the user for the base URL when it
does not know it.

## The endpoint

| Fact | Value |
|---|---|
| Route | `GET {base}/skill.zip` |
| Auth | None. Served ahead of the sign-in gateway, next to `/docs`, `/llms.txt`, and `/og.png`. |
| Host | The instance's base host only (`CANVAS_DROP_BASE_URL`). In `subdomain` URL mode, `/skill.zip` on a canvas host such as `{slug}.canvases.example.com` belongs to that canvas (its own file, or its 404). In `path` mode every host is the base host, so nothing collides. |
| Response | `200` with `Content-Type: application/zip`, `Content-Disposition: attachment; filename="canvas-drop-skill.zip"`, `Cache-Control: public, max-age=3600`. |
| Contents | `canvas-drop/SKILL.md` plus every `canvas-drop/examples/*.md`. Nothing else can appear: the server zips an explicit allowlist (`SKILL.md` and the Markdown files in `examples/`), never a directory glob, so a stray file or secret is never served. A missing `examples/` folder still yields a valid zip with `SKILL.md` alone. |
| `404` | The server cannot read `skill/canvas-drop/SKILL.md` on disk. See [Keeping it current](#keeping-it-current). |

## What the skill teaches

Inside, the skill covers the same surface as this docs site, condensed for an agent
that is parsing rather than reading.

| Section | What the agent learns | Full reference |
|---|---|---|
| Rules that always hold | Never put a secret in canvas files. Canvases are static files with no server-side build step. Backend is off by default: a primitive call throws `CapabilityDisabledError` (`code: "CAPABILITY_DISABLED"`, status 403) until an owner or editor turns it on (the Backend tab, or `set_capabilities` over MCP). A deploy is live at once and the last 10 versions are kept. Public link is static-only (`STATIC_ONLY`, 403). | [Capabilities](/docs/authoring/capabilities) |
| Pick a path | `curl` against the Deploy API for file transfer, so bytes stream from disk instead of through the model; MCP for everything else. The MCP deploy tools inline file bytes and suit a small first publish. | [llms.txt](/docs/agents/llms) |
| Connect over MCP | Add `{base}/mcp`, sign in once through the instance's own login, then call identity-scoped tools with no key to paste: `whoami`, `list_canvases`, `create_canvas`, `deploy_canvas`, the staged `begin_deploy` / `add_files` / `finalize_deploy` upload, `get_canvas_file` to verify what went live, `rollback_canvas`, the draft-editor loop, sharing and people tools, teams, and `list_canvas_connections`. 47 tools in all, each acting only on canvases the account owns or edits; anything else reads as `canvas not found`, and an owner-only act (`delete_canvas`, `transfer_canvas`, the guest-AI fields of `update_canvas`) fails with `OWNER_ONLY` for an editor. | [MCP server](/docs/agents/mcp) |
| Deploy over HTTP | A per-canvas `cd_...` key as `Authorization: Bearer`. `PUT {base}/v1/canvases/{id}/deploy` with a ZIP body publishes immediately. For large or repeat deploys, the staged upload (`POST .../uploads`, `PUT .../uploads/{uploadId}/blobs/{hash}`, `POST .../uploads/{uploadId}/finalize`) sends only the blobs the server does not hold. Read-back and recovery routes (`GET .../{id}`, `.../versions`, `.../files[?path=]`, `POST .../rollback`, `POST .../unpublish`) confirm a deploy and undo it. The agent takes the exact URLs from the `deploy` block that `create_canvas` and `get_canvas` return instead of guessing the API host. | [Deploy API](/docs/api/deploy-api) |
| Add backend capability | One `<script src="/sdk/v1.js"></script>` tag defines the global `window.canvasdrop` (there is no `cd` alias) and rides the signed-in session cookie, so the six fixed primitives (KV, files, AI, identity via `me()`, realtime, admin-granted Connections) work with no keys in canvas code. The skill lists the exact signatures that trip agents up, such as `ai.chat(messages, { model })`, `connections.fetch(profile, path, init?)`, and no generic `channel.on(event)`. | [SDK overview](/docs/sdk/overview) |
| Errors | Branch on the stable `err.code` and `err.status`, never on the message. The skill carries the full code table and which codes arrive as typed subclasses. | [Error codes](/docs/api/errors) |
| Verify through the server | The live URL is access-controlled, so an unauthenticated `GET` returns a login page, not the files. The agent confirms a deploy with the returned `{version, fileCount}`, with `list_versions` (`current: true`), or with `get_canvas_file`. | [MCP server](/docs/agents/mcp) |

## Keeping it current

The server builds the zip in-process from its own `skill/canvas-drop/` files at
startup (memoized for the life of the process), so what you download always matches
the version the instance is running. After an instance upgrade, run the install
command again; `unzip -o` overwrites the previous copy.

A `404` from `{base}/skill.zip` means the running server cannot read
`skill/canvas-drop/SKILL.md`. The Docker image ships the directory; a hand-rolled
deploy must copy `skill/` next to the server, the same way it copies
`docs/site/assets`. That is an operator fix, not something the agent can work around.

## Lighter alternative

For a copy-into-context version with no install step, use
[`{base}/llms.txt`](/llms.txt), the single-file agent quick reference. It is public
too, served on the same base host. The [llms.txt page](/docs/agents/llms) explains
what it contains.

# Agent skill

Install this skill so your coding agent can create, deploy, verify, and extend
canvases on this instance first try. It is a standard skill package: a `SKILL.md`
with `name`/`description` frontmatter and a when-to-use trigger, so an agent host
that discovers skills loads it on its own when a task matches.

## Install

`GET {base}/skill.zip` is public. No session, cookie, or API key is required, so an
agent can fetch and unpack it in one step:

```bash
curl -fL "{base}/skill.zip" -o canvas-drop-skill.zip
unzip -o canvas-drop-skill.zip -d ~/.claude/skills/
```

Replace `{base}` with the instance's base URL. The archive unpacks to one folder:

```
canvas-drop/
  SKILL.md          # the skill (frontmatter: name: canvas-drop)
  examples/poll.md  # a single-file live poll built on KV
```

Drop that folder wherever your agent discovers skills (the command above uses the
per-user Claude Code location), or point the agent at the unpacked `SKILL.md`
directly. The skill carries no instance-specific configuration: it refers to the
instance as `{base}` and asks the user for the base URL when it does not know it.

To check the install:

```bash
ls ~/.claude/skills/canvas-drop
# SKILL.md  examples
```

## What the skill teaches

The zip is built in-process from an explicit allowlist (`SKILL.md` plus
`examples/*.md`), never a directory glob, so it cannot carry a stray file or secret.
Inside, the skill covers the same surface as this docs site, condensed for an agent:

- **Connect over MCP.** Add `{base}/mcp`, sign in once through the instance's own
  login, then call identity-scoped tools with no key to paste: `whoami`,
  `list_canvases`, `create_canvas`, `deploy_canvas`, the staged
  `begin_deploy` / `add_files` / `finalize_deploy` upload, `get_canvas_file` to
  verify what went live, `rollback_canvas`, the draft-editor loop, sharing and
  people tools, and more. 46 tools in all, each acting only on canvases you own or
  edit; anything else reads as `canvas not found`. See the
  [MCP server](/docs/agents/mcp).
- **Deploy over HTTP** with a per-canvas `cd_…` key. `PUT {base}/v1/canvases/{id}/deploy`
  (Bearer auth, ZIP body) publishes immediately. For large or repeat deploys the skill
  uses the staged upload (`POST …/uploads` → `PUT …/uploads/{uploadId}/blobs/{hash}` →
  `POST …/uploads/{uploadId}/finalize`) so only changed blobs are sent. Read-back and
  recovery routes (`GET …/{id}`, `…/versions`, `…/files`, `POST …/rollback`,
  `POST …/unpublish`) let the agent confirm a deploy and undo it. The skill prefers
  `curl` for file transfer so bytes stream from disk instead of through the model.
  See the [Deploy API](/docs/api/deploy-api).
- **Add backend capability** with the zero-config browser SDK. One
  `<script src="/sdk/v1.js"></script>` tag defines the global `window.canvasdrop`
  (there is no `cd` alias) and rides the signed-in session cookie, so the five
  primitives (KV, files, AI, identity via `me()`, realtime) work with no keys in
  canvas code. See the [SDK overview](/docs/sdk/overview).
- **The golden rules.** Never put a secret in canvas files. Canvases are static
  files only, with no server-side build step. Backend is off by default; a call to
  a primitive that is not switched on throws `CapabilityDisabledError`
  (`code: "CAPABILITY_DISABLED"`, status 403) until an owner or editor enables it
  (Backend tab, or `set_capabilities` over MCP).
- **Typed errors.** Branch on the stable `err.code` and `err.status` rather than
  parsing messages. Full table at [Error codes](/docs/api/errors).

## Keeping it current

The zip is assembled from the running instance's own `skill/` files, so what you
download always matches the version the instance is serving. After an instance
upgrade, run the install command again; `unzip -o` overwrites the previous copy.

A `404` from `{base}/skill.zip` means the instance was deployed without its `skill/`
directory. That is an operator fix, not something the agent can work around.

## Lighter alternative

For a copy-into-context version with no install step, use
[`{base}/llms.txt`](/llms.txt), the single-file agent quick reference. It is public
too. The [llms.txt page](/docs/agents/llms) explains what it contains.

# Agent skill

Install this skill so your coding agent deploys and extends canvases against this
instance, first try, without manual correction. It ships in the standard skill
format (a `SKILL.md` with `name`/`description` frontmatter and a when-to-use
trigger), so an agent loads it automatically when a task matches.

## Download

`GET /skill.zip` is public. No session or API key is required, so an agent can
fetch it directly:

```bash
curl -fLO "{base}/skill.zip"
```

Replace `{base}` with this instance's base URL. The download is named
`canvas-drop-skill.zip`.

## Install

Unzip into your agent's skills directory:

```bash
unzip canvas-drop-skill.zip -d ~/.claude/skills/
```

The archive unpacks to a single `canvas-drop/` folder containing `SKILL.md` plus an
`examples/` directory. Point your agent at the unpacked `SKILL.md`, or drop the
folder wherever your agent discovers skills. The skill is self-contained: it refers
to this instance by base URL and asks the user for `{base}` when it doesn't know it.

## What's inside

The zip is built from an explicit allowlist (`SKILL.md` plus `examples/*.md`), so it
never carries a stray secret. The skill covers four ways to work against this
instance:

- **Connect over MCP.** Add `{base}/mcp`, sign in once through the instance's own
  login, then call identity-scoped tools (`whoami`, `list_canvases`,
  `create_canvas`, `deploy_canvas`, `get_canvas_file`, `rollback_canvas`, and more)
  with no key to paste. See the [MCP server](/docs/agents/mcp).
- **Deploy over HTTP** with a per-canvas API key:
  `PUT {base}/v1/canvases/{id}/deploy` (Bearer auth, ZIP body) publishes
  immediately. Companion read-back and recovery routes (`GET {base}/v1/canvases/{id}`,
  `…/versions`, `…/files`, `POST …/rollback`, `POST …/unpublish`) let an agent
  confirm what went live and undo it. See [Deploy API](/docs/api/deploy-api).
- **Add backend capability** with the zero-config browser SDK. One
  `<script src="/sdk/v1.js">` tag defines the global `canvasdrop` and rides the
  signed-in session cookie, so the five primitives (KV, files, `me()`, AI, realtime)
  work with no keys in client code. See the [SDK overview](/docs/sdk/overview).
- **The golden rules.** Never put a secret in canvas files. Canvases are static
  only, with no server build step. Every primitive is off until the owner enables
  Backend plus that feature, so a disabled call throws `CapabilityDisabledError`.
- **Typed errors.** Branch on a stable `err.code` / `err.status` rather than parsing
  messages. Full table at [Error codes](/docs/api/errors).

## Lighter alternative

For a copy-into-context version with no install step, use
[`{base}/llms.txt`](/llms.txt), the single-file agent quick reference.

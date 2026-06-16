# Agent skill

Install the skill so your coding agent deploys and extends canvases against this
instance without manual correction. It uses the standard skill format — a
`SKILL.md` with `name`/`description` frontmatter and a when-to-use trigger — so an
agent loads it automatically when a task matches.

## Download

`GET /skill.zip` is public — no session or API key required — so an agent can
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

The archive unpacks to a single `canvas-drop/` folder containing `SKILL.md` and a
`examples/` directory. Point your agent at the unpacked `SKILL.md`, or drop the
folder wherever your agent discovers skills. The skill is self-contained and refers
to this instance by its base URL — it asks the user for `{base}` when unknown.

## What's inside

The zip is built from an explicit allowlist (`SKILL.md` plus `examples/*.md`), so
it never carries a stray secret. It covers:

- **Connect over MCP** — add `{base}/mcp`, sign in once, and use the identity-scoped
  tools (`create_canvas`, `deploy_canvas`, `list_canvases`, …) with no key to paste.
  See the [MCP server](/docs/agents/mcp).
- **Deploy over HTTP** with a per-canvas API key —
  `PUT {base}/v1/canvases/{id}/deploy` (Bearer auth, ZIP body), plus the companion
  state/`versions`/`rollback` operations. See [Deploy API](/docs/api/deploy-api).
- **Add backend capability** with the zero-config browser SDK: one
  `<script src="/sdk/v1.js">` tag defines the global `canvasdrop` and rides the
  signed-in session cookie. See the [SDK overview](/docs/sdk/overview).
- **The golden rules:** never put a secret in canvas files; canvases are static
  only (no server build step); every primitive is off until the owner enables
  Backend plus the feature, so a disabled call throws `CapabilityDisabledError`.
- **Typed errors:** branch on a stable `err.code` / `err.status`. Full table at
  [Error codes](/docs/api/errors).

## Lighter alternative

For a copy-into-context version with no install step, use
[`{base}/llms.txt`](/llms.txt) — the single-file agent quick reference.

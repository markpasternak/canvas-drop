# Agent skill

canvas-drop ships an installable agent skill that teaches a coding agent to deploy
and extend canvases against your instance. It follows the Claude-skill /
`AGENTS.md` conventions.

## Get it

Download the packaged skill:

```
GET {base}/skill.zip
```

It contains a `SKILL.md` (when-to-use + the deploy/SDK workflow) and runnable
examples. The archive is public — no session required — so an agent can fetch it
directly.

## What it covers

- Obtaining and using a per-canvas API key.
- Deploying with the [Deploy API](/docs/api/deploy-api).
- Using the [browser SDK](/docs/sdk/overview) primitives inside a canvas.
- The zero-secrets rule: never put a provider or canvas key in canvas files.

## Install

Unzip into your agent's skills directory (or point your agent at the unpacked
`SKILL.md`). The skill is self-contained and references this instance's API by its
base URL.

For the lighter-weight, copy-into-context version, use
[`/llms.txt`](/llms.txt).

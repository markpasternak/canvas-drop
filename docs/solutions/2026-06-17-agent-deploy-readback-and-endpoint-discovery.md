---
title: Agents deploying canvases — read-back verification + endpoint discovery (don't make the agent probe)
type: architecture
area: mcp
date: 2026-06-17
---

How a coding agent deploys a canvas and **confirms it worked** without fighting the
platform — and why the server must *hand the agent the exact curl endpoints* instead of
letting it probe. Read before touching the MCP tool surface (`apps/server/src/mcp/*`),
the keyed Deploy API (`apps/server/src/routes/deploy-api.ts`), or the agent-facing docs
(`skill/canvas-drop/SKILL.md`, `docs/site/agents/*`). See also
[[2026-06-16-mcp-server-on-hono-and-token-lifecycle]],
[[2026-06-13-canvas-hosting-deploy-patterns]], [[2026-06-13-auth-invariant-checklist]].

## The three failures real agents hit

Observed from agents using the canvas-drop MCP elsewhere (not in this repo):

1. **"Can I even publish?"** — every deploy goes **live immediately** (no draft step over
   MCP/HTTP), and the live URL is **access-controlled** (org sign-in / share rung). The
   tool descriptions didn't say either, so the agent couldn't tell that `deploy` =
   publish-to-an-authed-URL.
2. **Bytes through the model.** The agent base64'd a zip and pasted it into a
   `deploy_canvas` tool call; the string got truncated mid-stream. Every MCP deploy tool
   *inlines file bytes into the model context* — wasteful and failure-prone for anything
   non-trivial.
3. **Verifying by fetching the URL.** The agent tried to `curl` the canvas URL to confirm
   the deploy. In subdomain mode that returns a **login page** (it's gated), so the agent
   concluded the deploy failed when it hadn't.

## The fixes (and the principle behind each)

- **State the publish/visibility contract in the tool descriptions themselves**, not just
  the docs. "Publishes immediately to a live, access-controlled URL" is load-bearing
  context an agent needs at the call site.
- **Strongly prefer `curl` over inlining bytes** — and say so *in the tool descriptions*,
  including "ask for command permission rather than inlining." The staged HTTP flow
  (`POST …/uploads` → `PUT …/uploads/{id}/blobs/{hash}` → `POST …/uploads/{id}/finalize`)
  streams each blob's raw bytes straight from disk; they never enter the model context.
- **Verify through the server, never the gated URL.** Two parity surfaces resolve the
  *same bytes a browser would get*, via the shared `liveManifest(versions, currentVersionId)`
  helper (`apps/server/src/canvas/manifest.ts`):
  - MCP `get_canvas_file` — listing, or one file's content (text as UTF-8, binary as
    base64; >256 KiB → hash-only metadata, since this inlines into context).
  - HTTP `GET /v1/canvases/:id/files` — JSON listing, or `?path=` for **raw bytes**
    (no size cap; `curl … | sha256sum` to confirm). Owner-scoped via the canvas key.

## The non-obvious one: don't make the agent discover the API host

The biggest time-sink was **endpoint discovery**. The agent had the key from
`create_canvas` but had to probe hosts to find where the Deploy API lives. In subdomain
mode the API host is **not** the dashboard/canvas host:

- `CANVAS_DROP_BASE_URL=https://canvas-drop.com` (canvases are `{slug}.canvas-drop.com`).
- The wildcard `*.canvas-drop.com` Caddy route also matches `api.canvas-drop.com`, so the
  pre-gateway `/v1/canvases/*` mount is reachable there — but the app's own config didn't
  know that host, so it couldn't *tell* the agent.

Fixes:

1. **New `CANVAS_DROP_API_BASE_URL` config** (`config.apiBaseUrl`, defaults to `baseUrl`).
   Set it only when the API is fronted on a dedicated host (e.g. `api.example.com`). Prod
   sets `CANVAS_DROP_API_BASE_URL=https://api.canvas-drop.com`.
2. **`create_canvas`/`get_canvas` advertise a `deploy` block** — `deployEndpoints(config,
   id, apiKey?)` in `apps/server/src/canvas/url.ts` returns the exact `apiBase`,
   `zipUpload`, staged URLs, `readback`, and a copy-paste `curl` (real key at create, a
   `$CANVAS_KEY` placeholder on `get_canvas`). The agent uses these verbatim — nothing to
   probe.

**Principle: when an agent needs a concrete address/command to act, the server should
return it, not document a `{base}` placeholder and leave the agent to resolve it.** A
placeholder in prose is a probing session waiting to happen.

## Gotcha: the API host must be a reserved slug

If the API is on `api.{domain}` in subdomain mode, a canvas with slug `api` would shadow
it. Already covered: `api`, `v1`, `sdk`, `auth`, `mcp` (plus `www`/`app`/`admin`/…) are in
`RESERVED_SLUGS` (`packages/shared/src/canvas/slug-policy.ts`). Any *new* infra subdomain
you front must be added there too.

## Don't re-derive the live-version read

`liveManifest` is now the single read path for both verification surfaces. The
asset-serving middleware (`canvas/serve.ts`) keeps its own copy **on purpose** — it also
needs the version row for ETag/cache handling — but anything that just wants "the live
manifest" (MCP read-back, HTTP read-back, draft dirty-check) goes through the shared
helper so they can't drift on the "what counts as live" rule (`currentVersionId` set AND
`status === "ready"` AND a manifest present).

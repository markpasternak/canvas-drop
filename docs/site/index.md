# canvas-drop

canvas-drop is an open-source, self-hostable platform where members of an
organization deploy and share small web artifacts called **canvases**. A canvas
is just static files (HTML, CSS, JS, images). Drop them in and they're live at a
URL your colleagues can open.

The constraint is the product: a small set of primitives, done well, instead of
a general-purpose hosting platform. Canvases run with no build step and no
secrets in the page, and they gain backend capability only through five
primitives (KV, files, AI, identity, realtime) exposed by a zero-config browser
SDK.

**Status:** v1 is feature-complete and hardening toward a public release. The
Docker image, one-command compose, MCP server, and examples have all shipped. The
remaining ops/packaging work (M10) is proving the backup/restore round-trip, a
single-VPS load test, and a colleague IAP pilot. See
[Self-hosting → Install](/docs/self-hosting/install).

## What you can build

Prototypes, dashboards, demos, microsites, small games, internal tools: anything
that communicates better as a working artifact than as a screenshot or a slide.

## How it fits together

- **Publish** a canvas four ways: paste a single `index.html`, drag a folder of
  files, upload a `.zip`, or call the [deploy API](/docs/api/deploy-api) with a
  per-canvas key. Agents can ship without a human in the loop, either over that
  HTTP API or through the built-in [MCP server](/docs/agents/mcp) at `{base}/mcp`.
  You can also edit in the browser and **Publish** from the draft.
- **Add backend capability** with the [browser SDK](/docs/sdk/overview) at
  `{base}/sdk/v1.js`: key-value storage, file storage, the signed-in viewer's
  identity (`me()`), AI, and realtime. The owner opts a canvas into **backend**
  (off by default), then toggles `kv`, `files`, `ai`, and `realtime`
  independently; `me()` is on whenever backend is on. AI needs a provider key
  configured on the instance, and realtime needs the operator's realtime switch
  on.
- **Version and roll back.** Every publish is an immutable version (last 10
  kept); one-click **Make current** switches the served version in either
  direction.
- **Share** the URL on a per-canvas access rung: `private` (owner only),
  `specific_people` (named org members and email-invited guests), `whole_org`
  (any signed-in member with the link), or `public_link` (anyone with the link,
  admin-gated per owner, and static-only). Layer on a per-canvas password or a
  share expiry, and opt into the gallery to let colleagues browse it. A canvas
  must be published before any shared rung takes effect.

## Where to go next

- New here? Start with the [Quickstart](/docs/quickstart).
- Building a canvas with a backend? Read the [SDK overview](/docs/sdk/overview).
- Running your own instance? See [Self-hosting → Install](/docs/self-hosting/install).
- An AI agent? Read [`/llms.txt`](/llms.txt) and the [agent skill](/docs/agents/skill).

> Examples and URLs in these docs use `{base}` (your instance's base URL) and
> `localhost` placeholders. Substitute your own instance's address.

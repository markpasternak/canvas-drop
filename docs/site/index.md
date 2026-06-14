# canvas-drop

canvas-drop is an open-source, self-hostable platform where members of an
organization deploy and share small web artifacts — **canvases**. A canvas is
just static files (HTML, CSS, JS, images). Drop them in and they're live at a
URL your colleagues can open.

The constraint is the product: a small set of primitives, done well, instead of
a general-purpose hosting platform. Canvases run with no build step and no
secrets in the page, and they gain backend capability only through five
primitives exposed by a zero-config browser SDK.

**Status:** v1 is feature-complete and hardening toward a public release. The
remaining work is ops/packaging (a Docker image + compose file, a backup/restore
drill, and a single-VPS load test) — see [Self-hosting → Install](/docs/self-hosting/install).

## What you can build

Prototypes, dashboards, demos, microsites, small games, internal tools — anything
that communicates better as a working artifact than as a screenshot or a slide.

## How it fits together

- **Deploy** a canvas four ways: paste a single `index.html`, drag a folder of
  files, upload a `.zip`, or call the [deploy API](/docs/api/deploy-api) with a
  per-canvas key (agents can ship without a human in the loop). You can also edit
  in the browser and **Publish** from the draft.
- **Add backend capability** with the [browser SDK](/docs/sdk/overview) at
  `{base}/sdk/v1.js`: key–value storage, file storage, the signed-in viewer's
  identity (`me()`), AI, and realtime. The owner opts a canvas into **backend**
  (off by default), then toggles `kv`, `files`, `ai`, and `realtime`
  independently; `me()` is on whenever backend is on.
- **Version & roll back.** Every publish is an immutable version (last 10 kept);
  one-click rollback swaps the live pointer.
- **Share** the URL. Access follows your instance's sign-in. Share a canvas
  publicly, set an expiry, or lock it with a per-canvas password; opt into the
  gallery to let colleagues browse it.

## Where to go next

- New here? Start with the [Quickstart](/docs/quickstart).
- Building a canvas with a backend? Read the [SDK overview](/docs/sdk/overview).
- Running your own instance? See [Self-hosting → Install](/docs/self-hosting/install).
- An AI agent? Read [`/llms.txt`](/llms.txt) and the [agent skill](/docs/agents/skill).

> Examples and URLs in these docs use `{base}` (your instance's base URL) and
> `localhost` placeholders. Substitute your own instance's address.

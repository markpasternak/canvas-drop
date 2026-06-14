# canvas-drop

canvas-drop is an open-source, self-hostable platform where members of an
organization deploy and share small web artifacts — **canvases**. A canvas is
just static files (HTML, CSS, JS, images). Drop them in and they're live at a
URL your colleagues can open.

The constraint is the product: a small set of primitives, done well, instead of
a general-purpose hosting platform. Canvases run with no build step and no
secrets in the page, and they gain backend capability only through five
primitives exposed by a zero-config browser SDK.

## What you can build

Prototypes, dashboards, demos, microsites, small games, internal tools — anything
that communicates better as a working artifact than as a screenshot or a slide.

## How it fits together

- **Deploy** a canvas by dragging a folder/ZIP into the dashboard, pasting HTML,
  using the in-browser editor, or calling the [deploy API](/docs/api/deploy-api)
  (agents can ship without a human in the loop).
- **Add backend capability** with the [browser SDK](/docs/sdk/overview): key–value
  storage, file storage, the signed-in viewer's identity, AI, and realtime — each
  gated by a capability the canvas owner turns on.
- **Share** the URL. Access follows your organization's sign-in.

## Where to go next

- New here? Start with the [Quickstart](/docs/quickstart).
- Building a canvas with a backend? Read the [SDK overview](/docs/sdk/overview).
- Running your own instance? See [Self-hosting → Install](/docs/self-hosting/install).
- An AI agent? Read [`/llms.txt`](/llms.txt) and the [agent skill](/docs/agents/skill).

> Examples and URLs in these docs use `{base}` (your instance's base URL) and
> `localhost` placeholders. Substitute your own instance's address.

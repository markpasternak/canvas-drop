# Primitives showcase

A single-page canvas that demonstrates all five canvas-drop backend primitives —
**identity**, **KV**, **files**, **AI**, and **realtime** — from plain static files.
No framework, no build step.

```
showcase/
  index.html      one page, one <script src="/sdk/v1.js"> tag, copy + controls
  styles.css      a small, unbranded design system (light/dark)
  js/
    main.js       mounts each section; one failure never breaks the others
    lib.js        helpers + graceful-degradation state cards (keyed on err.code)
    identity.js   canvasdrop.me()
    kv.js         shared counter + per-user note (canvasdrop.kv / kv.user)
    files.js      upload / list / delete (canvasdrop.files)
    ai.js         streamed chat (canvasdrop.ai.stream)
    realtime.js   presence + broadcast chat + live poll (canvasdrop.realtime)
```

## Run it locally

From the repo root, with a dev server running (`pnpm dev`):

```bash
pnpm seed:showcase
```

That deploys this folder as a live canvas (slug `showcase`) owned by your dev
user, with the backend + all capabilities enabled, and prints the URL. Re-running
re-deploys the latest files to the same canvas.

## Deploy it to your own instance

1. Create a canvas in the dashboard (or via the deploy API).
2. Under **Settings → Capabilities**, turn the backend **on** and enable the
   primitives you want (KV, files, AI, realtime).
3. Deploy this folder — drag it in, or `PUT` a ZIP to the deploy API with the
   canvas's Bearer key.

## Capability notes

Each section degrades on its own: if a capability is off (or, for **AI**, the
operator hasn't set a provider key), that section shows a small explanatory card
instead of an error — the rest of the page keeps working. Enable everything for
the full demo.

**Presence** lists *distinct* signed-in people, so opening two tabs as the same
user counts once. Broadcasts and the poll still sync across every connection.

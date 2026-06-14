# Quickstart

Stand up a local instance, then deploy your first canvas.

## Run an instance locally

The zero-config default is `path` + `sqlite` + `local` + `dev` auth — no external
services, no proxy, signed in as a dev user.

```sh
git clone https://github.com/<your-fork>/canvas-drop.git
cd canvas-drop
pnpm install
cp .env.example .env
pnpm dev
```

`pnpm dev` loads `.env` once and runs the server (`tsx watch`) and the dashboard
(`vite`) together. In dev the dashboard runs at `http://localhost:5173` (the Vite
dev server, with HMR), which proxies API/auth/v1 requests to the Hono server on
`:3000`. (In production the Hono server serves the built SPA on `:3000`.) SQLite
lives at `./data/canvasdrop.db` and uploaded files at `./data/storage`.

To stop: `pnpm dev:stop`. To restart: `pnpm dev:restart`.

In `dev` auth mode you're signed in as `dev@example.com` (override with
`CANVAS_DROP_DEV_USER_EMAIL` / `CANVAS_DROP_DEV_USER_NAME`). `dev` mode is
rejected when `NODE_ENV=production` — see [Configuration](/docs/self-hosting/configuration) and
[Self-hosting → Install](/docs/self-hosting/install) for `proxy` / `oidc` auth, Postgres,
and S3, all of which are config swaps, not code changes.

## Create a canvas

From the dashboard, click **New**. Four deploy paths:

- **Paste HTML** — a single `index.html`, created and deployed in one step.
- **Files / folder** — drag files or a folder; relative paths are kept at the
  canvas root.
- **ZIP** — upload an archive; it's extracted server-side.
- **Use the API** — get a slug and a per-canvas key for programmatic deploys.

Each canvas gets a slug and a URL. In `path` mode that's `{base}/c/{slug}/`; in
`subdomain` mode it's `{slug}.{base}` (e.g. `http://localhost:3000/c/{slug}/`).

## Add some content

A canvas is static files. The simplest canvas is one `index.html`:

```html
<!doctype html>
<html>
  <body>
    <h1>Hello from my canvas</h1>
  </body>
</html>
```

No build step runs on the server — what you deploy is what's served.

## Give it a backend (optional)

Add the SDK for storage, identity, and more, with no keys in the page:

```html
<script src="/sdk/v1.js"></script>
<script>
  (async () => {
    const me = await canvasdrop.me();
    await canvasdrop.kv.increment("views");
  })();
</script>
```

The owner enables **Backend** (and the specific primitive — kv, files, ai,
realtime) in the canvas's **Backend** tab first. Identity (`me()`) is on
whenever Backend is on. See the [SDK overview](/docs/sdk/overview).

## Publish & share

Open the canvas, edit in the **Draft** tab, then **Publish** to snapshot an
immutable version and point the live URL at it. Roll back from the **Deploys**
tab. Who can open a canvas follows your instance's sign-in — canvases are
private to your org by default.

## Deploying as an agent

Agents deploy over HTTP with a per-canvas API key — no dashboard session needed.
A `deploy` is live: it publishes a version directly with no draft loop. See the
[Deploy API](/docs/api/deploy-api) and [`/llms.txt`](/llms.txt).

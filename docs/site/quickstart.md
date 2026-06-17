# Quickstart

Stand up a local instance and publish your first canvas. The commands below get
you a logged-in instance on `localhost` with no external services.

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

From the dashboard, click **Create canvas**. Four ways to publish:

- **Paste HTML** — a single `index.html`, created and published in one step.
- **Files or folder** — drag files or a folder; relative paths are kept at the
  canvas root.
- **Upload ZIP** — upload an archive; it's extracted server-side.
- **Use the API** — get a slug and a per-canvas key for programmatic deploys.

Each canvas gets a slug and a URL. The slug is a random, unguessable name by default
(`quiet-otter-x7k2…`); you can type your own in the **Slug** field when creating a
canvas, or change it later under **Settings → Change slug** (leave it empty for a fresh
random one). In `path` mode the URL is `{base}/c/{slug}/` (e.g.
`http://localhost:3000/c/{slug}/`); in `subdomain` mode it's `{slug}.{base}` (e.g.
`{slug}.canvases.example.com`).

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

The owner enables **Backend** (off by default) and the specific primitive (kv,
files, ai, realtime) in the canvas's **Backend** tab first. Identity (`me()`) is
on whenever Backend is on. A primitive is live only when Backend is on, its flag
is on, and the operator has it available (ai needs a configured provider key;
realtime needs `CANVAS_DROP_REALTIME=on`, the default). See the
[SDK overview](/docs/sdk/overview).

## Publish & share

Open the canvas, edit in the **Editor** tab, then **Publish** to snapshot an
immutable version and point the canvas URL at it. Roll back or switch the current
version from the **Versions** tab. Set who can open it in the **Share** tab: the
access ladder runs **Private** (owner only, the default — a non-owner admin is
treated like any member and the canvas 404s for them) → **Specific
people** (an email allowlist, including email-invited guests) → **Whole org** (any
signed-in member with the link) → **Public link** (anyone with the link;
admin-gated, static files only — primitives are refused for public visitors). On
top of any rung you can add a password gate or a share expiry. Once a version is
published you can also list the canvas in the gallery.

## Deploying as an agent

Agents deploy over HTTP with a per-canvas API key — no dashboard session needed.
A `deploy` is live: it publishes a version directly with no draft loop. Agents
can also connect to the instance's remote [MCP server](/docs/agents/mcp) at
`{base}/mcp` (on by default; OAuth 2.1/PKCE through your own login), or install
the [agent skill](/docs/agents/skill). See the
[Deploy API](/docs/api/deploy-api) and [`/llms.txt`](/llms.txt).

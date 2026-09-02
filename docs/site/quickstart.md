# Quickstart

Get a canvas-drop instance running on your machine and publish your first
canvas. The default profile needs no external services: SQLite, local disk
storage, path-mode URLs, and `dev` auth that signs you in automatically.

## Run an instance locally

You need Node 24 or newer and pnpm (the repo pins `pnpm@11.0.9` in
`package.json`).

```sh
git clone https://github.com/markpasternak/canvas-drop.git
cd canvas-drop
pnpm install
cp .env.example .env
pnpm dev
```

| URL | What it serves |
|-----|----------------|
| `http://localhost:5173` | The dashboard (Vite dev server with HMR). It proxies `/api`, `/auth`, `/v1`, `/docs`, and `/llms.txt` to the server. |
| `http://localhost:3000` | The Hono server: management API, Deploy API, MCP, docs, and the canvases themselves at `/c/{slug}/`. |

`curl http://localhost:3000/healthz` returns 200 once the database is reachable
and migrations have run.

What `pnpm dev` does: it loads `.env` once (Node's `--env-file-if-exists`, so
exported variables still win), seeds a fresh database with sample canvases, then
runs the server (`tsx watch`), the dashboard (`vite`), and the browser SDK build
(esbuild watch) in parallel. In production the server serves the built dashboard
itself on `:3000`; the Vite server is dev-only.

The sample data is 100 empty canvases (no files) across seven owners, 70 of them
yours, so the dashboard and gallery are populated on first boot. It runs only when
the database has no canvases. Skip it with `CANVAS_DROP_DEV_SEED=0 pnpm dev`; wipe
the local database and storage with `pnpm reset:data`.

Useful commands:

- `pnpm dev:stop` stops the whole tree (Ctrl-C works too); `pnpm dev:restart`
  restarts it.
- `CANVAS_DROP_PORT=3001 pnpm dev` moves the server if `:3000` is taken; the
  dashboard proxy follows.
- Data lives at `./data/canvasdrop.db` (SQLite) and `./data/storage` (uploaded
  files).

### Who you are signed in as

In `dev` auth mode every request is `dev@example.com` (`Dev User`), and that
account is an admin (`CANVAS_DROP_ADMIN_EMAILS` defaults to the dev user in this
mode). Override the identity with `CANVAS_DROP_DEV_USER_EMAIL` and
`CANVAS_DROP_DEV_USER_NAME` in `.env`. `dev` mode refuses to boot when
`NODE_ENV=production`; a real instance uses `proxy` or `oidc` auth, and can swap
in Postgres and S3-compatible storage. Each of those is a config change, not a
code change: see [Configuration](/docs/self-hosting/configuration) and
[Install](/docs/self-hosting/install).

### Prefer Docker?

`docker compose up --build` starts a demo stack (the app in real `proxy` auth
mode behind oauth2-proxy and a bundled Dex identity provider, plus Postgres) at
`http://localhost:8080`; log in as `demo@example.com` / `canvasdrop`. Details and
the production shape are in [Install](/docs/self-hosting/install).

## Create a canvas

Click **Create canvas** in the dashboard (or open `/new`). Pick a source:

- **Paste HTML**: a single `index.html`, created and published in one step.
- **Files or folder**: drag files or a folder; relative paths are kept at the
  canvas root.
- **Upload ZIP**: extracted server-side; dotfiles are stripped.
- **Use the API**: mints an empty canvas plus a per-canvas key (shown once) and
  a ready-to-run `curl` command for programmatic deploys.

On the same screen you set a title, an optional custom slug (live availability
check), the audience the canvas opens to after it publishes (**Only me** by
default), and whether to enable the backend. The first three sources publish
immediately; **Use the API** waits for your first deploy.

Every canvas gets a slug and a URL. The default slug is random and unguessable
(`quiet-otter-x7k2`); a custom slug is lowercase letters, digits, and hyphens,
1 to 63 characters, with a reserved-word list (`api`, `admin`, `docs`, and
similar). Change it later under **Settings → Change slug**; leave the field empty
for a fresh random one. In `path` mode the URL is `{base}/c/{slug}/`, so locally
`http://localhost:3000/c/quiet-otter-x7k2/`; in `subdomain` mode it is
`{slug}.{baseHost}`, for example `quiet-otter-x7k2.canvases.example.com`.

## Add some content

A canvas is static files, served as-is. No build step runs on the server. The
page at the canvas URL is the `index.html` at the root:

```html
<!doctype html>
<html>
  <body>
    <h1>Hello from my canvas</h1>
  </body>
</html>
```

Limits: 100 MB per canvas, 25 MB per file, 2 000 files. Each publish creates an
immutable version; the last 10 are kept.

## Give it a backend (optional)

The browser SDK gives a canvas the five primitives (KV, files, AI, identity,
realtime) with no keys in the page. Identity comes from the signed-in session and
the canvas is identified from its own URL:

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const me = await canvasdrop.me();
  const views = await canvasdrop.kv.increment("views");
</script>
```

The backend is off by default. Turn on **Enable backend** in the canvas's
**Backend** tab, then the primitives you need (Key-value storage, File storage,
AI, Realtime). Identity (`me()`) is on whenever the backend is on. A primitive is
live only when the backend is on, its own toggle is on, and the operator has it
available: AI needs `CANVAS_DROP_AI_API_KEY` set on the server, realtime needs
`CANVAS_DROP_REALTIME=on` (the default). A call to a disabled primitive throws
`CapabilityDisabledError`. See the [SDK overview](/docs/sdk/overview) and
[Capabilities](/docs/authoring/capabilities).

## Publish and share

The **Editor** tab works on a mutable draft with autosave; **Publish** (⌘↵)
snapshots it into a new immutable version and points the canvas URL at it. The
**Versions** tab lists every kept version: **Restore** copies one back into the
draft, **Make current** re-points the live URL at it (either direction),
**Download ZIP** exports it.

The **Share** tab sets who can open the canvas. Sharing needs a published
version. The ladder, from narrowest to widest:

| Rung | Who can open the URL |
|------|----------------------|
| **Private** (default) | You and any editors you add. A non-owner admin is treated like any member and gets a 404. |
| **Specific people** | People and teams on the access list, as viewers or editors. A new email becomes live only after that person's first verified sign-in. |
| **Team** | Members of the teams on the list. |
| **Whole org** | Any signed-in member with the link. |
| **Public link** | Anyone with the link, static files only: the primitives are refused for anonymous visitors. Needs the instance's public-links switch (on by default) and the owner account's public-publishing permission (granted by default, revocable by an admin). |

On top of any rung you can add a password gate or a share expiry. Team and
Whole-org shares are link-only by default; turn on **List for people with
access** to make them appear in the viewer's **Shared** view. The gallery is
narrower: it lists only Public-link canvases and Whole-org canvases their owners
explicitly add. Revoking access takes effect on the next request. Details in
[Sharing & access](/docs/authoring/sharing).

## Deploy as an agent

Scripts and agents deploy over HTTP with the per-canvas key, with no dashboard
session. A deploy is live: it publishes a version directly, with no draft step.

```sh
curl -X PUT "http://localhost:3000/v1/canvases/{id}/deploy" \
  -H "Authorization: Bearer cd_your_key" \
  --data-binary @site.zip
```

The key operates only on its own canvas and never belongs in canvas files. The
same surface offers `GET /v1/canvases/{id}/files` to read the live version back,
`POST …/rollback`, `POST …/unpublish`, and a staged upload (begin, stage only the
changed blobs, finalize) for large or frequently redeployed canvases. See the
[Deploy API](/docs/api/deploy-api).

Agents can also connect once to the instance's [MCP server](/docs/agents/mcp) at
`{base}/mcp` (on by default; OAuth 2.1 through your own sign-in) for the full
owner and editor surface, install the [agent skill](/docs/agents/skill), or read
the whole contract at [`/llms.txt`](/llms.txt).

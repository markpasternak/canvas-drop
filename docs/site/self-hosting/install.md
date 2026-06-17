# Install

Stand up a canvas-drop instance. Pick one of two starting points: a one-command
**Docker** stack that boots the real production shape (Caddy + an identity-aware proxy
+ Postgres), or the **Node dev profile** for hacking on the code. Everything you later
swap for production — database, storage, URL mode, auth — is a config change, never a
code change.

## With Docker (one command)

Requires **Docker** and **Docker Compose v2** (`docker compose`, not the legacy
`docker-compose`). From a clone of the repo:

```bash
git clone <your-fork-or-the-repo>
cd canvas-drop
docker compose up --build
# then open http://localhost:8080  and log in as  demo@example.com / canvasdrop
```

This boots the whole production shape with zero external setup: canvas-drop in real
`proxy` mode behind Caddy + oauth2-proxy + a bundled **Dex** demo IdP, with Postgres
and an optional MinIO (S3) profile (`docker compose --profile minio up`). The app
verifies a Dex-signed JWT against Dex's JWKS — the same cryptographic trust path you
would run in production. Only the proxy is exposed on the host; pause the stack with
`docker compose stop`, or tear it down and wipe data with `docker compose down -v`.

> The bundled Dex/oauth2-proxy secrets and the `demo@example.com` login are public,
> demo-only placeholders, and the stack runs on plain HTTP in path mode — **do not
> expose it to the internet as-is.** Rotate every secret and work the
> [graduation checklist](/docs/self-hosting/deploy) before any real use.

## Node dev profile

For developing canvas-drop itself. Requires **Node.js >= 24** and **pnpm 11**.

```bash
git clone <your-fork-or-the-repo>
cd canvas-drop
pnpm install
cp .env.example .env
pnpm dev
```

That boots a logged-in instance using the zero-config dev profile: path URLs,
SQLite (`./data/canvasdrop.db`), local file storage (`./data/storage`), and `dev`
auth (auto-login as `dev@example.com`). `dev` auth is rejected when
`NODE_ENV=production` — it is for local use only. In dev, `pnpm dev` runs the Hono
API on `http://localhost:3000` and the dashboard SPA (Vite, with HMR) on
`http://localhost:5173`; the API server serves the built SPA on `:3000` only in
production after `pnpm build`. Open the dashboard at `http://localhost:5173` and
deploy your first canvas — see the [Quickstart](/docs/quickstart).

## What you choose at install time

Everything swappable is behind an interface, selected by config — never a code
change:

- **Database** — SQLite (default) or Postgres.
- **Storage** — local filesystem (default) or S3-compatible.
- **URL mode** — path (`{base}/c/{slug}/*`) or subdomain (`{slug}.{base}`).
  Subdomain mode needs a non-localhost `CANVAS_DROP_BASE_URL` and a wildcard cert.
  If you front the programmatic Deploy API on a dedicated host (e.g.
  `api.example.com`) rather than the canvas host, set `CANVAS_DROP_API_BASE_URL` to
  it so the MCP tools advertise the right curl endpoints to agents (defaults to
  `CANVAS_DROP_BASE_URL`).
- **Auth** — `dev` (local only), `proxy` (an identity-aware proxy in front), or
  `oidc` (built-in OpenID Connect login). `proxy` and `oidc` require
  `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS`; running real auth in path mode also
  requires `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true`.

See [Configuration](/docs/self-hosting/configuration) for the env vars, the
[Security model](/docs/self-hosting/security-model) for the trade-offs, and
[Deploy](/docs/self-hosting/deploy) for a production setup.

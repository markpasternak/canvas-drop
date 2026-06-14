# Install

canvas-drop is 12-factor and self-hostable. The simplest way to try it is locally
with the bundled dev profile.

## Local (dev profile)

```bash
git clone <your-fork-or-the-repo>
cd canvas-drop
pnpm install
cp .env.example .env
pnpm dev
```

That boots a logged-in instance on `http://localhost:3000` using the zero-config
dev profile: path URLs, SQLite (`./data/canvasdrop.db`), local file storage
(`./data/storage`), and `dev` auth (auto-login as `dev@example.com`). `dev` auth
is rejected when `NODE_ENV=production` — it is for local use only. Open the
dashboard and deploy your first canvas — see the [Quickstart](/docs/quickstart).

## What you choose at install time

Everything swappable is behind an interface, selected by config — never a code
change:

- **Database** — SQLite (default) or Postgres.
- **Storage** — local filesystem (default) or S3-compatible.
- **URL mode** — path (`{base}/c/{slug}/*`) or subdomain (`{slug}.{base}`).
  Subdomain mode needs a non-localhost `CANVAS_DROP_BASE_URL` and a wildcard cert.
- **Auth** — `dev` (local only), `proxy` (an identity-aware proxy in front), or
  `oidc` (built-in OpenID Connect login). `proxy` and `oidc` require
  `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS`; running real auth in path mode also
  requires `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true`.

See [Configuration](/docs/self-hosting/configuration) for the env vars, the
[Security model](/docs/self-hosting/security-model) for the trade-offs, and
[Deploy](/docs/self-hosting/deploy) for a production setup.

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

That boots a logged-in instance on `localhost` using the dev profile:
path URLs, SQLite, local file storage, and `dev` auth (auto-login as a dev user).
Open the dashboard and deploy your first canvas — see the
[Quickstart](/docs/quickstart).

## What you choose at install time

Everything swappable is behind an interface, selected by config — never a code
change:

- **Database** — SQLite (default) or Postgres.
- **Storage** — local filesystem (default) or S3-compatible.
- **URL mode** — path (`{base}/c/{slug}`) or subdomain (`{slug}.{base}`).
- **Auth** — `dev` (local), `proxy` (an identity-aware proxy in front), or `oidc`
  (built-in OpenID Connect login).

See [Configuration](/docs/self-hosting/configuration) for the env vars, the
[Security model](/docs/self-hosting/security-model) for the trade-offs, and
[Deploy](/docs/self-hosting/deploy) for a production setup.

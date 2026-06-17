# Configuration

canvas-drop is configured entirely by environment variables, validated at boot. A
single config module is the only reader of `process.env`; everything else takes
typed config. Misconfiguration fails loudly at startup, not at request time.

This page is the env-var reference. The defaults below are the schema defaults
(authoritative); `.env.example` in the repo mirrors them with inline comments.
There is no telemetry and no phone-home — nothing is reported anywhere.

## How config gets loaded

- **Local dev:** `pnpm dev` reads a root `.env` file once (`node --env-file-if-exists=.env`). Copy the template and start:

  ```bash
  cp .env.example .env && pnpm dev
  ```

  Zero-config defaults give you a logged-in instance on `http://localhost:3000`: **path** URL mode + **sqlite** + **local** storage + **dev** auth.

- **Production:** the `.env` file is *not* read. Set variables in your process environment — a systemd `EnvironmentFile`, container env, or secrets manager.

## The four pluggable interfaces

Each interface is selected by one switch variable. Swapping a driver is a config
change, never a code change.

| Interface | Switch | Options (default first) | Driver-specific vars |
|-----------|--------|-------------------------|----------------------|
| Database | `CANVAS_DROP_DB` | `sqlite` / `postgres` | sqlite: `CANVAS_DROP_SQLITE_PATH`; postgres: `CANVAS_DROP_DATABASE_URL` |
| Storage | `CANVAS_DROP_STORAGE` | `local` / `s3` | local: `CANVAS_DROP_STORAGE_PATH`; s3: `CANVAS_DROP_S3_*` |
| URL mode | `CANVAS_DROP_URL_MODE` | `path` / `subdomain` | subdomain requires a non-localhost `CANVAS_DROP_BASE_URL` |
| Auth | `CANVAS_DROP_AUTH_MODE` | `dev` / `proxy` / `oidc` | proxy: JWT or trusted-header vars; oidc: `CANVAS_DROP_OIDC_*`; dev: `CANVAS_DROP_DEV_USER_*` |

## Core

| Variable | Default | Notes |
|----------|---------|-------|
| `NODE_ENV` | `development` | `development` \| `production` \| `test`. |
| `CANVAS_DROP_URL_MODE` | `path` | `path` serves `…/c/{slug}/*`; `subdomain` serves `{slug}.{baseHost}`. |
| `CANVAS_DROP_BASE_URL` | `http://localhost:3000` | Public base URL. In `subdomain` mode must be non-localhost or boot fails. |
| `CANVAS_DROP_API_BASE_URL` | (= `CANVAS_DROP_BASE_URL`) | Where the Deploy API (`/v1/canvases/*`) is reachable. Set only when the API is fronted on a different host than canvases — e.g. `subdomain` mode where canvases are `{slug}.canvases.example.com` but the API is routed at `https://api.canvases.example.com`. The MCP tools advertise curl endpoints built from this so agents don't probe for the host. (`api`/`v1`/`sdk`/`auth`/`mcp` are reserved slugs, so a canvas can't collide with it.) |
| `CANVAS_DROP_PORT` | `3000` | Listen port. |
| `CANVAS_DROP_SESSION_SECRET` | (dev fallback only) | **Required, ≥32 chars, outside dev and always in production.** Signs session cookies (oidc/dev). |
| `CANVAS_DROP_ADMIN_EMAILS` | (empty) | CSV; lowercased. Grants the admin surface. |
| `CANVAS_DROP_REALTIME` | `on` | `on` \| `off`. |
| `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE` | `false` | Must be `true` to boot `path` mode with `proxy`/`oidc` auth (path mode has reduced browser isolation). |
| `CANVAS_DROP_DASHBOARD_DIST` | (resolved) | Override the built dashboard SPA path; defaults to a location resolved from the server module. |

## Auth

`CANVAS_DROP_AUTH_MODE` selects how identity is established. Identity always comes
from the server-side auth strategy, never from anything the client sends.

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_AUTH_MODE` | `dev` | `dev` \| `proxy` \| `oidc`. `dev` is **rejected when `NODE_ENV=production`**. |
| `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` | (empty) | CSV, lowercased. **Required (≥1) in `proxy`/`oidc`.** |

> **Individual email allowlist.** Beyond the domain list above, an admin can allow
> specific outside emails to sign in (e.g. a contractor or a test account) under
> **Admin → Users → Allowed sign-in emails**. It's an additive, DB-managed layer:
> the env domain list is unchanged, and an email passes if its domain is allowed
> **or** it's on this list. Removing an entry revokes that email's access on its
> next sign-in.

### dev mode

Auto-logs-in a fixed local user; zero setup, localhost only.

| Variable | Default |
|----------|---------|
| `CANVAS_DROP_DEV_USER_EMAIL` | `dev@example.com` |
| `CANVAS_DROP_DEV_USER_NAME` | `Dev User` |

### oidc mode

The app owns login via Authorization-Code + PKCE.

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_OIDC_ISSUER` | (unset) | **Required.** Provider issuer URL. |
| `CANVAS_DROP_OIDC_CLIENT_ID` | (unset) | **Required.** |
| `CANVAS_DROP_OIDC_CLIENT_SECRET` | (unset) | **Required.** |

### proxy mode

Front the app with an identity-aware proxy. Exactly **one** trust path is active —
they do not compose. Configure **either** the JWT/JWKS path (preferred,
cryptographic) **or** the trusted-header path. Boot fails if neither is set.

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_AUTH_PROXY_EMAIL_HEADER` | `X-Auth-Request-Email` | Identity header (trusted-header path). |
| `CANVAS_DROP_AUTH_PROXY_NAME_HEADER` | `X-Auth-Request-Preferred-Username` | Display-name header. |
| `CANVAS_DROP_AUTH_PROXY_JWT_HEADER` | `Cf-Access-Jwt-Assertion` | Header carrying the proxy's signed JWT. |
| `CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL` | (unset) | Enables the JWT path. When set, identity headers are never honored. |
| `CANVAS_DROP_AUTH_PROXY_JWT_ISSUER` | (unset) | **Required when JWKS is set.** |
| `CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE` | (unset) | **Required when JWKS is set.** |
| `CANVAS_DROP_TRUSTED_PROXY_IPS` | (empty) | CSV of IPv4/CIDR. The only peers whose identity headers are trusted. Gates on the socket peer IP; `/0` is rejected. Also keys the login rate limit in oidc. |

In `proxy` mode you must set either `CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL` (with
its issuer and audience) **or** `CANVAS_DROP_TRUSTED_PROXY_IPS`.

## Database

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_DB` | `sqlite` | `sqlite` \| `postgres`. |
| `CANVAS_DROP_SQLITE_PATH` | `./data/canvasdrop.db` | sqlite file path. |
| `CANVAS_DROP_DATABASE_URL` | (unset) | **Required when `CANVAS_DROP_DB=postgres`.** |

## Storage

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_STORAGE` | `local` | `local` \| `s3`. |
| `CANVAS_DROP_STORAGE_PATH` | `./data/storage` | local storage root. |
| `CANVAS_DROP_S3_ENDPOINT` | (unset) | Custom endpoint for MinIO / R2. |
| `CANVAS_DROP_S3_BUCKET` | (unset) | **Required when `CANVAS_DROP_STORAGE=s3`.** |
| `CANVAS_DROP_S3_REGION` | (unset) | **Required when `s3`.** |
| `CANVAS_DROP_S3_ACCESS_KEY` | (unset) | **Required when `s3`.** |
| `CANVAS_DROP_S3_SECRET_KEY` | (unset) | **Required when `s3`.** |
| `CANVAS_DROP_S3_FORCE_PATH_STYLE` | `true` | Keep `true` for MinIO. |

## Rate limiting

In-process counters with a fixed 60-second window; they reset on restart. Each
limit is an integer ≥ 1 (boot fails on `0` or negative).

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_RATELIMIT_ENABLED` | `true` | Master toggle. |
| `CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN` | `120` | |
| `CANVAS_DROP_RATELIMIT_AI_PER_MIN` | `10` | |
| `CANVAS_DROP_RATELIMIT_DEPLOY_PER_MIN` | `10` | Keyed per canvas. |
| `CANVAS_DROP_RATELIMIT_MANAGEMENT_PER_MIN` | `120` | |
| `CANVAS_DROP_RATELIMIT_LOGIN_PER_MIN` | `10` | Keyed on resolved client IP. |
| `CANVAS_DROP_RATELIMIT_PASSWORD_GATE_PER_MIN` | `5` | |

## AI (optional)

The AI primitive is off until `CANVAS_DROP_AI_API_KEY` is set. The key is
server-side only and is never exposed to the browser.

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_AI_PROVIDER` | `anthropic` | |
| `CANVAS_DROP_AI_API_KEY` | (unset) | Unset/blank disables AI. |
| `CANVAS_DROP_AI_BASE_URL` | (unset) | Override the provider base URL. |
| `CANVAS_DROP_AI_MODELS` | `claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-8` | CSV allowlist. |
| `CANVAS_DROP_AI_USER_DAILY_USD` | `5` | Per-user daily spend cap. |
| `CANVAS_DROP_AI_CANVAS_MONTHLY_USD` | `50` | Per-canvas monthly spend cap. |

## Email (guest invites)

Sends the magic-link sign-in emails for **email-invited guests** (the
`specific_people` access rung). It is a driver-behind-interface like the database
and storage, so adding a future provider is a config change. Guest invites and
public links are app-gated-mode features (`oidc`/`dev`); in `proxy` mode the
upstream IAP owns the boundary and invites are refused. Provider secrets are
server-side only and never logged.

| Variable | Default | Notes |
| --- | --- | --- |
| `CANVAS_DROP_EMAIL_DRIVER` | `log` | `log` (writes the link to the server log — zero-setup dev) \| `smtp` \| `mailgun` \| `noop` (disables invites). |
| `CANVAS_DROP_EMAIL_FROM` | `no-reply@<mailgun domain>` or `no-reply@localhost` | Sender address. |
| `CANVAS_DROP_SMTP_HOST` | (unset) | SMTP server host (driver `smtp`). |
| `CANVAS_DROP_SMTP_PORT` | `587` | `587` = STARTTLS, `465` = implicit TLS. |
| `CANVAS_DROP_SMTP_USER` / `CANVAS_DROP_SMTP_PASS` | (unset) | Omit both for an IP-allowlisted relay. |
| `CANVAS_DROP_SMTP_SECURE` | `false` | `true` for implicit TLS (port 465). |
| `CANVAS_DROP_MAILGUN_API_KEY` | (unset) | Mailgun HTTP API key (driver `mailgun`). |
| `CANVAS_DROP_MAILGUN_DOMAIN` | (unset) | e.g. `mg.example.com`. |
| `CANVAS_DROP_MAILGUN_BASE_URL` | `https://api.mailgun.net` | Use `https://api.eu.mailgun.net` for EU. |

## Logging & error tracking

Structured logs go to stdout via pino — no app-side files, rotation, or shipping.

| Variable | Default | Notes |
|----------|---------|-------|
| `LOG_LEVEL` | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`. |
| `LOG_FORMAT` | `pretty` in dev, `json` in production | `json` \| `pretty`. |
| `CANVAS_DROP_SENTRY_DSN` | (unset) | Reserved: the DSN is read into config and shown in the admin Configuration view, but no error-tracking integration consumes it yet — setting it does not enable error reporting. |

> All examples use placeholder values. Never commit real secrets — set them in
> your deployment environment (systemd, container env, secrets manager).

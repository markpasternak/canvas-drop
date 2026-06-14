# Configuration

canvas-drop is configured entirely by environment variables, validated at boot. A
single config module is the only reader of the environment; everything else takes
typed config. Misconfiguration fails loudly at startup rather than at request time.

This is a tour of the load-bearing settings — see `.env.example` in the repo for
the full, commented list.

## Core

| Variable | Purpose |
|----------|---------|
| `CANVAS_DROP_BASE_URL` | The instance's public base URL. |
| `CANVAS_DROP_PORT` | Port to listen on. |
| `CANVAS_DROP_URL_MODE` | `path` or `subdomain`. |
| `CANVAS_DROP_SESSION_SECRET` | Secret for session signing (set a strong value in prod). |

## Auth

| Variable | Purpose |
|----------|---------|
| `CANVAS_DROP_AUTH_MODE` | `dev`, `proxy`, or `oidc`. |
| `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` | Restrict sign-in to these domains. |
| `CANVAS_DROP_ADMIN_EMAILS` | Who gets the admin surface. |
| `CANVAS_DROP_TRUSTED_PROXY_IPS` | In `proxy` mode, the only peers allowed to assert identity. |
| `CANVAS_DROP_OIDC_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` | `oidc` provider settings. |

## Database & storage

| Variable | Purpose |
|----------|---------|
| `CANVAS_DROP_DB` | `sqlite` or `postgres`. |
| `CANVAS_DROP_DATABASE_URL` | Postgres connection string. |
| `CANVAS_DROP_STORAGE` | `local` or `s3`. |
| `CANVAS_DROP_S3_*` | S3 endpoint, bucket, region, credentials. |

## AI (optional)

| Variable | Purpose |
|----------|---------|
| `CANVAS_DROP_AI_API_KEY` | Provider key (server-side only; unset disables AI). |
| `CANVAS_DROP_AI_USER_DAILY_USD` / `_CANVAS_MONTHLY_USD` | Spend caps. |

> All examples use placeholder values. Never commit real secrets — set them in
> your deployment environment (systemd, container env, secrets manager).

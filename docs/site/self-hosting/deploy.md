# Deploy

Stand up a production instance: one app process behind a TLS-terminating reverse
proxy. canvas-drop is a single Hono server that role-routes the dashboard, auth,
the platform API, and canvas serving — one process, one log stream. Its
dependencies (Postgres, an identity-aware proxy, optional S3/MinIO) are separate
off-the-shelf services, never baked in.

The app reads identity only from its server-side auth context, so the only thing
the proxy must do correctly is assert who the user is. Everything else is a config
swap — see [Configuration](/docs/self-hosting/configuration) for the full env
surface (config is the single `process.env` reader).

## Recommended production profile

- **URL mode:** `subdomain` (`{slug}.{base}`) — per-canvas origin isolation. Requires a
  non-localhost `CANVAS_DROP_BASE_URL`.
- **Auth:** `proxy` with JWT verification, behind an identity-aware proxy / IAP.
- **Database:** Postgres (`CANVAS_DROP_DB=postgres`).
- **Storage:** S3-compatible (`CANVAS_DROP_STORAGE=s3`).
- **TLS:** wildcard cert at the proxy, covering `{base}` and `*.{base}`.

Any Docker host, VPS, PaaS, or Kubernetes cluster works. The target is a single
modest box (< €15/mo). None of these choices is mandatory — each interface
(DB, storage, URL mode, auth) is a config switch you can change later without
touching code.

## Shape

```
            ┌─────────────────────────┐
  client ──▶│ identity-aware proxy/IAP │  terminates TLS, asserts identity
            └────────────┬────────────┘
                         ▼
                 canvas-drop app  ── Postgres
                                   └ S3-compatible storage
```

The app should not be directly reachable; only the proxy talks to it. The proxy
must **overwrite** (not append) the identity headers it forwards.

## Auth at the edge

Pick exactly one proxy trust path — they do not compose:

- **JWT / JWKS (preferred, cryptographic):** the proxy forwards a signed JWT
  (default header `Cf-Access-Jwt-Assertion`). Set `CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL`,
  `CANVAS_DROP_AUTH_PROXY_JWT_ISSUER`, and `CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE`. When
  JWKS is configured, plain identity headers are never honored — a stray identity
  header without a valid JWT resolves to anonymous.
- **Trusted header (only when no JWKS is set):** the app trusts the forwarded email
  header (default `X-Auth-Request-Email`) **only** when the request's socket peer IP
  is listed in `CANVAS_DROP_TRUSTED_PROXY_IPS` (CSV of IPv4 addresses/CIDRs; `/0` is
  rejected so "trust everything" is impossible). A header from any other source is
  ignored.

Proxy mode refuses to boot without either a JWKS URL or a trusted-proxy IP set. See
the [Security model](/docs/self-hosting/security-model) for the full §12.5 invariant.

Two other auth modes exist for production: `oidc` and `dev`. In `proxy` and `oidc`
modes you must set `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` (≥1 domain). `dev` mode is
rejected when `NODE_ENV=production`.

## Without a proxy

If you don't run an identity-aware proxy, use the built-in `oidc` mode — point it at
your OpenID provider:

```
CANVAS_DROP_AUTH_MODE=oidc
CANVAS_DROP_OIDC_ISSUER=https://accounts.example.com
CANVAS_DROP_OIDC_CLIENT_ID=...
CANVAS_DROP_OIDC_CLIENT_SECRET=...
CANVAS_DROP_ALLOWED_EMAIL_DOMAINS=example.com
CANVAS_DROP_SESSION_SECRET=...   # ≥32 chars; required in production
```

The app then owns login (Authorization Code + PKCE) and issues its own session
cookie — real auth with no extra infrastructure. `oidc` mode also accepts
`CANVAS_DROP_TRUSTED_PROXY_IPS` so login rate-limiting keys on the real client IP
when you front it with a plain TLS proxy.

## Running the process

There is no app Dockerfile or `docker-compose.yml` in the repo yet — the
multi-stage image and compose stack are a documented target, not shipped. Today you
run the built Node process directly.

Build, then start the server (production uses the `node-dist` export condition so the
shared package resolves to compiled JS, not TS source):

```
pnpm install --frozen-lockfile
pnpm build
node --conditions=node-dist apps/server/dist/index.js
```

Supply env via your process manager rather than a `.env` file — the `.env` file is
only read by `pnpm dev`. A systemd unit with `EnvironmentFile=` and a TLS proxy
(Caddy, nginx, Cloudflare Tunnel, etc.) in front is enough to run a small instance
on one box: the app binds a local port (default `3000`) and the proxy reverse-proxies
to it.

## Graduating later (config only)

Start simple, scale by changing env — never code:

- **Storage → object store:** `CANVAS_DROP_STORAGE=s3` plus `CANVAS_DROP_S3_BUCKET`,
  `CANVAS_DROP_S3_REGION`, `CANVAS_DROP_S3_ACCESS_KEY`, `CANVAS_DROP_S3_SECRET_KEY`
  (and `CANVAS_DROP_S3_ENDPOINT` for MinIO/R2; `CANVAS_DROP_S3_FORCE_PATH_STYLE=true`
  for MinIO).
- **Database → Postgres:** `CANVAS_DROP_DB=postgres` plus `CANVAS_DROP_DATABASE_URL`.
- **Auth → IAP:** put a JWT-issuing identity-aware proxy in front and switch
  `CANVAS_DROP_AUTH_MODE=proxy`.

## Backups

The backup target is the data directory: the SQLite DB (`CANVAS_DROP_SQLITE_PATH`,
default `./data/canvasdrop.db`) and local storage (`CANVAS_DROP_STORAGE_PATH`,
default `./data/storage`). On the blessed profile, back up Postgres with nightly
`pg_dump` and rely on object-store versioning for files.

## Logs

Structured JSON to stdout via pino — no app-side files, rotation, or shipping. Tune
with `LOG_LEVEL` (default `info`) and `LOG_FORMAT` (`json` in production, `pretty` in
dev by default). Correlation IDs come from `X-Correlation-ID` / `X-Request-Id`. Error
tracking is off unless you set `CANVAS_DROP_SENTRY_DSN`. No telemetry or phone-home.

See [Configuration](/docs/self-hosting/configuration) for the full env surface.

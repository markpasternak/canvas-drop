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

**Fastest path to a working production-shaped stack** (Docker, zero external setup —
canvas-drop in real `proxy` mode behind Caddy + oauth2-proxy + a bundled demo IdP):

```
docker compose up --build
# open http://localhost:8080  and log in as  demo@example.com / canvasdrop
```

The rest of this page covers the recommended profile, the auth-at-the-edge contract,
graduating off the demo IdP, and running the bare Node process.

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

Two other auth modes exist: `oidc` and `dev`. In `proxy` and `oidc` modes you must
set `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` (≥1 domain; CSV, lowercased) — it is enforced
on every request. `dev` mode auto-logs-in a fixed local user with zero verification
and is rejected at boot when `NODE_ENV=production`.

Running real auth (`proxy`/`oidc`) in `path` URL mode also requires
`CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true` — the app refuses to boot otherwise,
because path mode has reduced per-canvas browser isolation. Set it only when you
accept that tradeoff (the demo compose stack does, since `subdomain` can't run on
localhost). `subdomain` mode needs no such opt-in.

In `proxy` mode the app is sessionless: the IAP owns the session and identity is
verified per request from the forwarded JWT (or trusted header). In `oidc` mode the
app owns login and issues its own HttpOnly session cookie.

## Without a proxy

If you don't run an identity-aware proxy, use the built-in `oidc` mode — point it at
your OpenID provider. Run it in `subdomain` mode so you keep per-canvas origin
isolation without standing up a proxy:

```
CANVAS_DROP_URL_MODE=subdomain
CANVAS_DROP_BASE_URL=https://canvases.example.com
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

## Run with Docker (recommended)

The repo ships a multi-stage `Dockerfile` (one slim, non-root application image) and a
`docker-compose.yml` that boots the **whole production shape with zero external setup**:
canvas-drop in real `proxy` mode behind Caddy + oauth2-proxy + a bundled **Dex** demo IdP,
with Postgres and an optional MinIO (S3) profile.

```
docker compose up --build
# open http://localhost:8080  and log in as  demo@example.com / canvasdrop
```

The app verifies a Dex-signed JWT against Dex's JWKS — the cryptographic §12.5 trust path,
not a plaintext header. The app publishes no host port; only Caddy is reachable.
`./scripts/compose-smoke.sh` boots the stack and asserts the launch invariants (no host
exposure, unauthenticated requests blocked, forged identity headers rejected, a real login
resolves the demo identity, and data survives a restart).

The bundled Dex/oauth2-proxy secrets in `docker/` are **clearly-labeled demo-only
placeholders** — see "Graduating" below before exposing the stack to anyone.

### The image itself

The `Dockerfile` is multi-stage on `node:24-slim`: a `builder` stage compiles the
workspace, the `runtime` stage carries no compilers and runs as a dedicated non-root
`canvasdrop` user (uid/gid 1001). Operational contract:

- **`EXPOSE 3000`**, `NODE_ENV=production`, entry
  `node --conditions=node-dist apps/server/dist/index.js`.
- **`VOLUME /data`** — the writable state directory, pre-chowned to the non-root user.
  Defaults inside the image: `CANVAS_DROP_STORAGE_PATH=/data/storage`,
  `CANVAS_DROP_SQLITE_PATH=/data/canvasdrop.db`. Mount a volume here on the SQLite +
  local-storage profile so data survives container replacement.
- **`HEALTHCHECK`** polls `GET /healthz`, which pings the DB and returns 503 until the
  database is reachable and migrations have run (60s start period covers Postgres
  startup + migrations). Wire this into your orchestrator's readiness probe.

### Graduating to a real IdP (config, not code)

Moving off the bundled demo IdP is a configuration change — no app code changes — but it is
not thoughtless. Work the checklist:

1. Point oauth2-proxy (or your own IAP) and `CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL` /
   `…_ISSUER` / `…_AUDIENCE` at your real provider (Google, Okta, Cloudflare Access, …).
2. Confirm **which JWT claim carries the verified email** and that it maps to identity.
3. Confirm `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` covers your real users.
4. Switch `CANVAS_DROP_URL_MODE=subdomain` once you have real wildcard DNS + a wildcard cert
   (the demo runs `path` mode because subdomain can't boot on localhost).
5. Rotate every demo secret; set `cookie_secure=true` at the proxy once TLS terminates there.
6. Re-run the forged-token rejection check against the new wiring.

Prefer the **JWKS path** in production: it is cryptographic and does not depend on pinning
trusted-proxy IPs. See `.env.production.example` for the full annotated prod profile.

## Running the bare process

If you prefer not to use Docker, run the built Node process directly.

Build, then start the server (production uses the `node-dist` export condition so the
shared package resolves to compiled JS, not TS source):

```
pnpm install --frozen-lockfile
pnpm build
node --conditions=node-dist apps/server/dist/index.js
```

`pnpm build` builds the shared package's `dist/` first; the `node-dist` export
condition makes `@canvas-drop/shared` resolve to that compiled JS, so production
runs without `tsx`. The Node engine requirement is ≥ 24.

Supply env via your process manager rather than a `.env` file — the `.env` file is
only read by `pnpm dev`. A systemd unit with `EnvironmentFile=` and a TLS proxy
(Caddy, nginx, Cloudflare Tunnel, etc.) in front is enough to run a small instance
on one box: the app binds a local port (default `3000`) and the proxy reverse-proxies
to it. Set `CANVAS_DROP_SESSION_SECRET` (≥32 chars) — it is required in production.

## Graduating later (config only)

Start simple, scale by changing env — never code:

- **Storage → object store:** `CANVAS_DROP_STORAGE=s3` plus `CANVAS_DROP_S3_BUCKET`,
  `CANVAS_DROP_S3_REGION`, `CANVAS_DROP_S3_ACCESS_KEY`, `CANVAS_DROP_S3_SECRET_KEY`
  (and `CANVAS_DROP_S3_ENDPOINT` for MinIO/R2; `CANVAS_DROP_S3_FORCE_PATH_STYLE=true`
  for MinIO).
- **Database → Postgres:** `CANVAS_DROP_DB=postgres` plus `CANVAS_DROP_DATABASE_URL`.
- **Auth → IAP:** put a JWT-issuing identity-aware proxy in front and switch
  `CANVAS_DROP_AUTH_MODE=proxy`.
- **A CDN in front:** see [Behind a CDN](/docs/self-hosting/cdn) — set the trusted-proxy
  IPs and client-IP header so rate-limiting/audit stay per-user, add a cache rule that
  bypasses on the session cookie, and review the public edge-cache TTL.

## Backups

The backup target is the data directory: the SQLite DB (`CANVAS_DROP_SQLITE_PATH`,
default `./data/canvasdrop.db`) and local storage (`CANVAS_DROP_STORAGE_PATH`,
default `./data/storage`). Use SQLite's `.backup` for a consistent snapshot of a
live DB rather than copying the file. On the Postgres + S3 profile, back up Postgres
with nightly `pg_dump` and rely on object-store versioning for files.

## Logs

Structured JSON to stdout via pino — no app-side files, rotation, or shipping. Tune
with `LOG_LEVEL` (default `info`) and `LOG_FORMAT` (`json` in production, `pretty` in
dev by default). Correlation IDs come from `X-Correlation-ID` / `X-Request-Id`. Error
tracking is off unless you set `CANVAS_DROP_SENTRY_DSN`. No telemetry or phone-home.

See [Configuration](/docs/self-hosting/configuration) for the full env surface.

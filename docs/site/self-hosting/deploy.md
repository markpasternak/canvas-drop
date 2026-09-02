# Deploy

Run canvas-drop in production: one Node process behind a TLS-terminating reverse
proxy that asserts who the user is. The app is a single Hono server that routes the
dashboard, auth, the management and platform APIs, canvas content, MCP, and the docs
from one port, with one log stream. Postgres, the identity-aware proxy, and
S3-compatible storage are separate off-the-shelf services you run next to it.

Identity only ever comes from the app's server-side auth context, so the proxy has one
security job: assert the user correctly. Everything else on this page is a config
switch. The full variable reference is on [Configuration](/docs/self-hosting/configuration).

The fastest way to see the production shape running is the bundled compose stack:
canvas-drop in real `proxy` mode behind Caddy, oauth2-proxy, and a demo IdP, with
Postgres.

```bash
docker compose up --build          # add -d to run in the background
# open http://localhost:8080 and sign in as demo@example.com / canvasdrop
```

This page covers the recommended profile, what the reverse proxy must do, auth at the
edge, the Docker image and compose stack, the bare-process alternative, and day-two
operations: health, upgrades, backups, logs.

## Recommended production profile

- **URL mode:** `subdomain` (`{slug}.{base}`), so every canvas is its own browser
  origin. Needs a non-localhost `CANVAS_DROP_BASE_URL`, wildcard DNS
  (`*.canvases.example.com`), and a wildcard certificate at the proxy.
- **Auth:** `proxy` with JWT verification, behind an identity-aware proxy (IAP).
- **Database:** Postgres (`CANVAS_DROP_DB=postgres`).
- **Storage:** S3-compatible (`CANVAS_DROP_STORAGE=s3`).
- **TLS:** terminated at the proxy, covering `{base}` and `*.{base}`.

`.env.production.example` in the repo is this profile, annotated. Any Docker host,
VPS, PaaS, or Kubernetes cluster works; the design target is a single modest box.
None of these choices is mandatory. Each interface (database, storage, URL mode,
auth) is a config switch you can change later without touching code.

## Shape

```
            ┌─────────────────────────┐
  client ──▶│ identity-aware proxy/IAP │  terminates TLS, asserts identity
            └────────────┬────────────┘
                         ▼
                 canvas-drop app  ── Postgres
                                   └ S3-compatible storage
```

The app must not be reachable directly; only the proxy talks to it. The proxy must
**overwrite** (never append to) the identity headers it forwards.

## What the reverse proxy must do

Whichever proxy you run (an IAP, Caddy, nginx, a tunnel), the app needs these
behaviors from it:

- **Preserve `Host`.** In subdomain mode the app picks the canvas from the `Host`
  header (`{slug}.{baseHost}`). Caddy forwards it by default; nginx needs
  `proxy_set_header Host $host`.
- **Pass WebSocket upgrades.** The realtime primitive is a WebSocket on the same
  port as everything else.
- **Allow large request bodies on deploy routes.** The app accepts up to 110 MB on
  `PUT /v1/canvases/{id}/deploy` and the dashboard deploy routes, and 26 MB per
  staged blob (`PUT /v1/canvases/{id}/uploads/{uploadId}/blobs/{hash}`). It returns
  `413` above those limits itself; a proxy with a lower cap fails deploys first.
- **Forward `Authorization` untouched** on `/v1/canvases/*` and `/mcp`, and route those
  paths around the IAP's login (see "Agents and CI behind an IAP" below).
- **Set `CANVAS_DROP_BASE_URL` to the public `https://` origin.** The app builds every
  absolute URL (canvas URLs, the OIDC redirect URI, MCP discovery metadata) from that
  variable and never reads `X-Forwarded-Proto`, so the plain-HTTP hop between proxy
  and app is fine.

## Auth at the edge

In `proxy` mode the app is sessionless: the IAP owns the session, and the app verifies
identity on every request from what the proxy forwards. Pick exactly one trust path.
They do not compose.

- **JWT / JWKS (preferred, cryptographic).** The proxy forwards a signed JWT (default
  header `Cf-Access-Jwt-Assertion`; set `CANVAS_DROP_AUTH_PROXY_JWT_HEADER` to change it).
  Set `CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL`, `CANVAS_DROP_AUTH_PROXY_JWT_ISSUER`, and
  `CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE`. The app checks the signature against the JWKS
  plus `iss`, `aud`, `exp`, and `nbf`, and takes the identity from the token's `email`
  claim. When a JWKS URL is set, plain identity headers are never honored: a stray
  `X-Auth-Request-Email` without a valid JWT resolves to anonymous and is logged.
- **Trusted header (only when no JWKS URL is set).** The app trusts the forwarded
  email header (default `X-Auth-Request-Email`) only when the request's TCP peer IP is
  listed in `CANVAS_DROP_TRUSTED_PROXY_IPS` (CSV of IPv4 addresses or CIDRs). Each entry
  is validated at boot: `/0`, malformed entries, and IPv6 are rejected, so
  "trust everything" cannot be configured. A header from any other peer is ignored.

Proxy mode refuses to boot without a JWKS URL or a trusted-proxy IP list. In `proxy`
and `oidc` modes you must also set `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` (one or more
domains; CSV, lowercased), which is enforced on every request, and a
`CANVAS_DROP_SESSION_SECRET` of at least 32 characters. The
[Security model](/docs/self-hosting/security-model) covers the invariants behind
these rules.

Running real auth (`proxy` or `oidc`) in `path` URL mode also requires
`CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true`, because path mode puts every canvas on
one browser origin. Set it only when you accept that tradeoff. The demo compose stack
does, since `subdomain` cannot boot on localhost. `subdomain` mode needs no opt-in.

The third mode, `dev`, auto-signs-in a fixed local user with no verification and is
rejected at boot when `NODE_ENV=production`.

### Agents and CI behind an IAP

Two surfaces authenticate themselves and never carry the IAP's browser session:

- **The Deploy API**, `/v1/canvases/*`, authenticates with a per-canvas secret key
  (`Authorization: Bearer cd_...`).
- **The MCP endpoint**, `/mcp`, authenticates with an OAuth 2.1 bearer token issued by
  the app itself; the endpoints it uses are advertised under `/.well-known/`. The
  one-time authorization step is a browser round-trip and does go through the IAP.

Configure the IAP to let those paths through unauthenticated and to forward
`Authorization` unchanged; the app rejects bad or missing tokens with `401`. In
subdomain mode a common layout is a dedicated API host: set
`CANVAS_DROP_API_BASE_URL` (for example `https://api.canvases.example.com`) so the MCP
tools advertise the right endpoints to agents. The demo Caddyfile strips
`Authorization` on purpose, which is why the Deploy API is unreachable in the demo.

Two related facts about anonymous traffic. `GET /healthz` is unauthenticated at the
app; the container health check calls it from inside, so expose it externally only if
a monitor needs it. And a Public-link canvas is only public if the IAP lets anonymous
requests reach the app: the app serves that rung (static files only) to a request with
no identity and nothing else. Behind an IAP that demands sign-in on every host, public
links land on the IAP's login page.

## Without an identity-aware proxy: `oidc`

If you do not run an IAP, use the built-in `oidc` mode and point it at your OpenID
provider. Run it in `subdomain` mode so you keep per-canvas origin isolation without
standing up a proxy; a plain TLS-terminating proxy in front is enough.

```
CANVAS_DROP_URL_MODE=subdomain
CANVAS_DROP_BASE_URL=https://canvases.example.com
CANVAS_DROP_AUTH_MODE=oidc
CANVAS_DROP_OIDC_ISSUER=https://accounts.example.com
CANVAS_DROP_OIDC_CLIENT_ID=...
CANVAS_DROP_OIDC_CLIENT_SECRET=...
CANVAS_DROP_ALLOWED_EMAIL_DOMAINS=example.com
CANVAS_DROP_SESSION_SECRET=...   # >= 32 chars; openssl rand -hex 32
```

Register `{base}/auth/callback` as the redirect URI at your provider. The app runs
Authorization Code + PKCE, rejects unverified emails, and issues its own session
cookie (`__canvasdrop_session`: HttpOnly, `Secure` in production, `SameSite=Lax`,
scoped to `.{baseHost}` in subdomain mode, 14-day rolling expiry). A request with no
session is redirected to `/auth/login`.

`oidc` mode also honors `CANVAS_DROP_TRUSTED_PROXY_IPS` (and `CANVAS_DROP_CLIENT_IP_HEADER`)
so login throttling and audit rows key on the real client IP behind your proxy; in
this mode those settings never assert identity. See [Behind a CDN](/docs/self-hosting/cdn).

## Run with Docker

There is no published image; build it from the repo. The `Dockerfile` is multi-stage on
`node:24-slim`: a `builder` stage compiles the workspace, and a `runtime` stage carries
no compilers and runs as a dedicated non-root `canvasdrop` user (uid/gid 1001).

```bash
docker build -t canvas-drop .
```

The image's operational contract:

- **Entry:** `node --conditions=node-dist apps/server/dist/index.js`, with
  `NODE_ENV=production` and `CANVAS_DROP_PORT=3000` (`EXPOSE 3000`) preset.
- **State:** `VOLUME /data`, pre-created and owned by the non-root user. In-image
  defaults: `CANVAS_DROP_SQLITE_PATH=/data/canvasdrop.db` and
  `CANVAS_DROP_STORAGE_PATH=/data/storage`. Mount a volume there on the SQLite +
  local-storage profile; on Postgres + S3 the container holds no state.
- **Health:** `HEALTHCHECK` fetches `http://127.0.0.1:3000/healthz` every 15 s with a
  60 s start period, which covers Postgres coming up and migrations running on a cold
  start. Wire the same URL into your orchestrator's readiness probe.
- **Config:** pass `CANVAS_DROP_*` as container environment. The image reads no `.env`.
- **Screenshots (optional):** the default image has no browser. Build with
  `--build-arg SCREENSHOTS=1` to add Chromium (about 300 MB), then run with
  `CANVAS_DROP_SCREENSHOTS=on` and flip the admin toggle. See
  [Screenshots](/docs/self-hosting/screenshots).

### The compose stack

`docker-compose.yml` boots the whole production shape with no external setup. It is
a demo of the wiring, not a production deployment as-is.

| Service | Image | Role |
|---|---|---|
| `caddy` | `caddy:2-alpine` | Edge proxy and the only service with a published port (`8080`). Routes `/dex/*` to Dex and everything else to oauth2-proxy, and strips client-supplied identity and `Authorization` headers on the way in. Plain HTTP for the demo; in production it would terminate TLS. |
| `oauth2-proxy` | `quay.io/oauth2-proxy/oauth2-proxy:v7.6.0` | The identity-aware proxy. Signs users in against Dex and forwards the Dex-signed access token to the app in `X-Forwarded-Access-Token`. |
| `dex` | `dexidp/dex:v2.41.1` | Bundled demo IdP with one static user, `demo@example.com` / `canvasdrop`. |
| `app` | built from the repo as `canvas-drop:dev` | canvas-drop in real `proxy` mode on the JWKS path: `CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL=http://dex:5556/dex/keys`, issuer `http://localhost:8080/dex`, audience `canvas-drop-demo`. `path` URL mode with `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true`, Postgres, local storage on the `app-data` volume, a `backups` volume. No published port. |
| `postgres` | `postgres:16-alpine` | The database, on the `pg-data` volume, with a `pg_isready` health check the app waits on. |
| `minio` | `minio/minio:RELEASE.2024-11-07T00-52-20Z` | Optional S3-compatible storage behind `--profile minio`. Starting it does not switch the app to S3; edit the `app` service's `environment:` block as shown on [Install](/docs/self-hosting/install). |

The app verifies a Dex-signed JWT against Dex's JWKS, the same cryptographic trust
path you run in production. The smoke test boots the stack and asserts the launch
invariants: the app reports healthy, the app has no host port, an unauthenticated
request is redirected, a forged `X-Forwarded-Access-Token` / `X-Auth-Request-Email`
pair is still redirected, a real Dex login resolves `demo@example.com` with
`authMode: proxy`, and the same user id survives `docker compose restart app postgres`.

```bash
./scripts/compose-smoke.sh              # leaves the stack running
KEEP_UP=0 ./scripts/compose-smoke.sh    # tears it down (docker compose down -v)
```

Every Dex and oauth2-proxy secret under `docker/` is a labeled demo placeholder, and
the stack runs plain HTTP in path mode. Work the checklist below before anyone but you
can reach it.

The compose file also carries a commented-out `maintenance` service: a supercronic
sidecar on the same image and volumes that runs the nightly `backup` (14-day retention)
and weekly `purge` from `docker/maintenance.cron`. Uncomment it and start it with
`docker compose --profile maintenance up -d`.

### Graduating to a real IdP

Moving off the bundled IdP is configuration, not code, but each step matters:

1. Point oauth2-proxy (or your own IAP) at your real provider, and set
   `CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL`, `CANVAS_DROP_AUTH_PROXY_JWT_ISSUER`, and
   `CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE` to match the tokens it forwards.
2. Confirm the forwarded JWT carries the verified email in its `email` claim; a token
   without one resolves to anonymous.
3. Set `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` to your real domains and
   `CANVAS_DROP_ADMIN_EMAILS` to your bootstrap admins.
4. Switch to `CANVAS_DROP_URL_MODE=subdomain` once wildcard DNS and a wildcard
   certificate exist, and drop `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE`.
5. Rotate every demo secret, including `CANVAS_DROP_SESSION_SECRET`; set
   `cookie_secure=true` at oauth2-proxy once TLS terminates at the edge.
6. If agents or CI will deploy, stop stripping `Authorization` for `/v1/canvases/*` and
   `/mcp` and exempt those paths from the IAP's login.
7. Re-run the forged-token check against the new wiring.

## Running the bare process

To run without Docker, build the workspace and start the compiled server. Node 24 or
newer and pnpm 11 are required.

```bash
pnpm install --frozen-lockfile
pnpm build
node --conditions=node-dist apps/server/dist/index.js
```

`pnpm build` compiles the shared package to `dist/` first; the `node-dist` export
condition makes `@canvas-drop/shared` resolve to that compiled JS, so production runs
without `tsx`.

Supply configuration through the process manager, not a `.env` file; only `pnpm dev`
reads `.env`. A systemd unit with `EnvironmentFile=` and a TLS proxy in front (Caddy,
nginx, a tunnel) is enough for a small instance on one box: the app binds a local port
(default `3000`) and the proxy reverse-proxies to it under the contract above.

## Health, boot, and upgrades

`GET /healthz` pings the database and answers `{"status":"ok","db":"ok","version":...}`
with `200`, or `status: degraded` with `503` when the database is unreachable. The
process validates its configuration first and exits with a message naming every
invalid variable, then runs pending migrations, then opens the port. A passing health
check therefore means the database is reachable and the schema is current.

Migrations run at boot in every mode; there is no separate migrate command. To
upgrade, take a backup, replace the image or the built tree, and restart. Migrations
are written to be additive, so an existing database is not rewritten in place; the
backup is your rollback.

## Backups and maintenance

The server binary doubles as the ops tool. The same image, the same config, no extra
tooling:

```bash
BIN="node --conditions=node-dist apps/server/dist/index.js"
$BIN backup /backups/$(date -u +%Y%m%dT%H%M%SZ)   # whole instance: every table + every blob
$BIN restore /backups/20260620T031500Z             # into an empty instance; --force to overwrite
$BIN purge 30                                      # reclaim canvases deleted 30+ days ago; add dry-run to preview
```

A backup is a self-describing directory (`meta.json`, `db/<table>.ndjson`, `blobs/<key>`)
written through the database and storage interfaces, so it is driver-agnostic: a
backup taken on SQLite + local disk restores into Postgres + S3 and vice versa. That
makes backup then restore the supported way to migrate between drivers. Restore
refuses a non-empty database without `--force` and verifies every row count and blob
hash before writing anything.

A backup is as sensitive as the database: it contains credential hashes, OAuth client
secrets, and personal data. Keep it on a separate volume, restrict it to the app user,
and encrypt it before it leaves the host. Run a restore drill into a throwaway instance
periodically; a green restore is the only proof a backup is real.

`purge` also prunes `usage_events` and `ai_usage` rows older than 90 days. A sensible
schedule is a nightly backup with 14-day local retention and a weekly `purge 30`,
either from a host crontab or the compose `maintenance` sidecar. The full runbook,
including cron lines and the restore drill, is `docs/ops.md` in the repo.

## Logs

Structured JSON to stdout via pino: no app-side files, rotation, or shipping. Tune
with `LOG_LEVEL` (default `info`) and `LOG_FORMAT` (`json` when `NODE_ENV=production`,
otherwise `pretty`). Correlation IDs are taken from `X-Correlation-ID` or `X-Request-Id`.
`/healthz` is excluded from request logging. Error tracking is off unless you set
`CANVAS_DROP_SENTRY_DSN`. There is no telemetry or phone-home.

## Changing drivers later

Start small and change env, never code:

| Move | Set |
|---|---|
| Local disk to object storage | `CANVAS_DROP_STORAGE=s3` plus `CANVAS_DROP_S3_BUCKET`, `CANVAS_DROP_S3_REGION`, `CANVAS_DROP_S3_ACCESS_KEY`, `CANVAS_DROP_S3_SECRET_KEY`; `CANVAS_DROP_S3_ENDPOINT` for MinIO or R2 (`CANVAS_DROP_S3_FORCE_PATH_STYLE` defaults to `true`). |
| SQLite to Postgres | `CANVAS_DROP_DB=postgres` plus `CANVAS_DROP_DATABASE_URL`. |
| Built-in login to an IAP | Put a JWT-issuing identity-aware proxy in front and set `CANVAS_DROP_AUTH_MODE=proxy` with the JWKS variables above. |
| A CDN in front | See [Behind a CDN](/docs/self-hosting/cdn): trusted-proxy IPs, the client-IP header, a cache rule that bypasses on the session cookie, and `CANVAS_DROP_PUBLIC_EDGE_CACHE_TTL`. |

Switching a driver changes where new data goes; to carry existing data across, take a
backup on the old drivers and restore it on the new ones.

See [Configuration](/docs/self-hosting/configuration) for the full env surface.

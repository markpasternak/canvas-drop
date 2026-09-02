# Install

You are standing up canvas-drop for the first time. By the end of this page you
have an instance you can sign in to, and you know which database, storage, URL
mode, and auth driver it is running. Two starting points, same repository:

```bash
git clone https://github.com/markpasternak/canvas-drop.git
cd canvas-drop

# Evaluate or self-host: the production shape behind an identity-aware proxy
docker compose up --build
# open http://localhost:8080  and sign in as  demo@example.com / canvasdrop

# Develop canvas-drop itself: SQLite, local storage, automatic sign-in
pnpm install && cp .env.example .env && pnpm dev
# open http://localhost:5173
```

| Path | Needs | What you get |
|---|---|---|
| [Docker Compose](#docker-compose) | Docker with Compose v2 (`docker compose`, not the legacy `docker-compose`) | An identity-aware proxy in front, canvas-drop in real `proxy` auth mode, Postgres, and a bundled demo identity provider on `http://localhost:8080`. Evaluate here; graduating the same files to a real IdP is configuration. |
| [From source](#run-from-source) | Node 24 or newer, pnpm 11 | `pnpm dev` on `http://localhost:5173` with SQLite, local storage, and `dev` auth that signs every request in. Develop canvas-drop itself, or try Bearer deploys and MCP with no proxy in the way. |

Both run the same code. Database, storage, URL mode, and auth are drivers behind
one switch variable each; swapping one later is a config change, never a code
change. The switches are listed in [What you choose at install
time](#what-you-choose-at-install-time).

## Docker Compose

```bash
docker compose up --build
docker compose ps app          # STATUS ends in "(healthy)" when the stack is ready
```

The first `--build` compiles the workspace inside the image. The server does not
listen until Postgres is reachable and migrations have run, and `GET /healthz`
returns 503 while the database is unreachable, so the container's health check
allows a 60-second start period before it counts failures. Sign in at
`http://localhost:8080` as `demo@example.com` / `canvasdrop`.

What comes up:

| Service | Image | Role |
|---|---|---|
| `caddy` | `caddy:2-alpine` | Edge proxy on host port `8080`, the only published port. Routes `/dex/*` to Dex and everything else to oauth2-proxy, and strips client-supplied identity and `Authorization` headers before they reach the auth layer. Plain HTTP for the demo; in production it would terminate TLS. |
| `oauth2-proxy` | `quay.io/oauth2-proxy/oauth2-proxy:v7.6.0` | Identity-aware proxy. Signs users in against Dex and forwards the Dex-signed access token to the app in `X-Forwarded-Access-Token`. |
| `dex` | `dexidp/dex:v2.41.1` | Bundled demo identity provider with one static user, `demo@example.com` / `canvasdrop`. |
| `app` | built from the repo `Dockerfile` as `canvas-drop:dev` | canvas-drop in `proxy` auth mode, verifying the JWT against Dex's JWKS (`CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL=http://dex:5556/dex/keys`). Path URL mode, Postgres, local storage on the `app-data` volume, a separate `backups` volume. No published port. |
| `postgres` | `postgres:16-alpine` | Database, on the `pg-data` volume, with a `pg_isready` health check the app waits on. |
| `minio` | `minio/minio:RELEASE.2024-11-07T00-52-20Z` | Optional S3-compatible storage. Starts only with `--profile minio` (below). |

What to know about the demo:

- The demo user is also the instance admin (`CANVAS_DROP_ADMIN_EMAILS:
  demo@example.com`), so the Admin area is available on first sign-in.
- It runs path URL mode (`{base}/c/{slug}/`) because subdomain mode refuses to
  boot on a localhost `CANVAS_DROP_BASE_URL`; `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE`
  is set to `true` for that reason. Path mode shares one browser origin across
  all canvases, so isolation is weaker than subdomain mode; production should use
  subdomain mode (see the [Security model](/docs/self-hosting/security-model)).
- The Deploy API (`/v1/canvases/*`) and MCP (`/mcp`) are not reachable through
  this edge: oauth2-proxy gates every route and Caddy strips `Authorization`.
  Deploy from the dashboard, or use the from-source profile to try Bearer
  deploys.
- The app's config is an inline `environment:` block on the `app` service in
  `docker-compose.yml` (no `env_file`). Change it by editing that file and running
  `docker compose up -d` again.

Pause the stack with `docker compose stop`. Tear it down and delete every volume
(`app-data`, `backups`, `pg-data`, `minio-data`) with `docker compose down -v`.

> The Dex and oauth2-proxy secrets in `docker/`, the session secret in
> `docker-compose.yml`, and the `demo@example.com` login are public, demo-only
> placeholders, and the stack serves plain HTTP in path mode. Do not expose it to a
> network as-is. Rotate every secret and work through "Graduating to a real IdP" on
> the [Deploy](/docs/self-hosting/deploy) page before any real use.

### Verify the launch invariants

`scripts/compose-smoke.sh` boots the stack (`docker compose up -d --build`), waits
up to two minutes for `app` to report healthy, and asserts the load-bearing
invariants: the app publishes no host port, an unauthenticated request is
redirected, a forged `X-Forwarded-Access-Token` / `X-Auth-Request-Email` pair is
still redirected, a real Dex sign-in resolves `/api/me` as `demo@example.com`
with `authMode: proxy`, and the same user id survives
`docker compose restart app postgres`. It needs `curl`.

```bash
./scripts/compose-smoke.sh             # boots, verifies, leaves the stack up
KEEP_UP=0 ./scripts/compose-smoke.sh   # same, then `docker compose down -v`
```

### Switch the demo to S3-compatible storage (MinIO)

`--profile minio` adds a MinIO container (`minioadmin` / `minioadmin`, data on the
`minio-data` volume). It does not switch the app over by itself: the `app` service
keeps `CANVAS_DROP_STORAGE: local` until you change it. Do this on a fresh
instance; blobs already written to local storage are not moved when the driver
changes (to move an existing instance, use `backup` and `restore`, below).

1. Start MinIO alongside the stack. Pass `--profile minio` on every later
   `docker compose` command too, or Compose leaves the MinIO container out.

   ```bash
   docker compose --profile minio up -d --build
   ```

2. Create the bucket. Neither MinIO nor the storage driver creates it on first
   write. The compose file publishes no MinIO port, so either run your S3 client
   inside the compose network, or add `ports: ["9000:9000"]` to the `minio`
   service and create it from the host (the AWS CLI works, as CI does for its
   own test bucket):

   ```bash
   AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin AWS_DEFAULT_REGION=us-east-1 \
     aws --endpoint-url http://localhost:9000 s3 mb s3://canvas-drop
   ```

3. Point the app at it. In `docker-compose.yml`, replace `CANVAS_DROP_STORAGE: local`
   on the `app` service with:

   ```yaml
       environment:
         # …
         CANVAS_DROP_STORAGE: s3
         CANVAS_DROP_S3_ENDPOINT: http://minio:9000
         CANVAS_DROP_S3_BUCKET: canvas-drop
         CANVAS_DROP_S3_REGION: us-east-1
         CANVAS_DROP_S3_ACCESS_KEY: minioadmin
         CANVAS_DROP_S3_SECRET_KEY: minioadmin
         CANVAS_DROP_S3_FORCE_PATH_STYLE: "true"
   ```

   `CANVAS_DROP_S3_ENDPOINT` is MinIO's in-network address.
   `CANVAS_DROP_S3_FORCE_PATH_STYLE` already defaults to `true`; it is shown for
   clarity. Boot refuses `CANVAS_DROP_STORAGE=s3` without bucket, region, access
   key, and secret key, naming each missing variable.

4. Apply. Compose recreates `app` with the new environment:

   ```bash
   docker compose --profile minio up -d
   ```

### Add Chromium for canvas screenshots

The preview/screenshot pipeline ships off, and the default image contains no
browser. Build with the `SCREENSHOTS` build arg (about 300 MB more, via
`playwright install --with-deps chromium`), then set `CANVAS_DROP_SCREENSHOTS=on`
and turn the feature on in Admin. Both are required; the env var only makes the
pipeline available.

```bash
docker build --build-arg SCREENSHOTS=1 -t canvas-drop:screenshots .
```

In the compose stack, give the `app` service the build arg and the env var:

```yaml
  app:
    build:
      context: .
      args:
        SCREENSHOTS: "1"
    environment:
      # …
      CANVAS_DROP_SCREENSHOTS: "on"
```

Details, tuning variables, and the memory cost are on the
[Screenshots](/docs/self-hosting/screenshots) page.

### Run the image with your own proxy, database, and IdP

There is no published image; build it from the repo. If you bring your own
reverse proxy, database, and identity provider, run the application image
directly.

```bash
docker build -t canvas-drop .
cp .env.production.example canvas-drop.env      # replace every CHANGE_ME / REPLACE_ME
docker run -d --name canvas-drop \
  --env-file canvas-drop.env \
  -p 127.0.0.1:3000:3000 \
  -v canvas-drop-data:/data \
  canvas-drop
curl -fsS http://127.0.0.1:3000/healthz
# 200 {"status":"ok","db":"ok","version":"..."}   (503 "degraded" until the DB answers)
```

`.env.production.example` is the annotated subdomain + `proxy` (JWKS) + Postgres +
S3 profile; `docker run --env-file` reads its `KEY=VALUE` lines and ignores the
comments. What the image fixes:

| Preset | Value |
|---|---|
| `NODE_ENV` | `production` (`dev` auth is refused; configure `proxy` or `oidc`) |
| `CANVAS_DROP_PORT` | `3000` (`EXPOSE 3000`) |
| Runtime user | `canvasdrop`, uid/gid 1001, non-root |
| `VOLUME /data` | writable, owned by the app user; `CANVAS_DROP_SQLITE_PATH=/data/canvasdrop.db`, `CANVAS_DROP_STORAGE_PATH=/data/storage` |
| `CANVAS_DROP_DASHBOARD_DIST` | `/app/apps/dashboard/dist` |
| `HEALTHCHECK` | `http://127.0.0.1:3000/healthz` every 15 s, 5 s timeout, 60 s start period, 5 retries |

Mount `/data` whenever you use SQLite or local storage; on Postgres + S3 the
container holds no state. The image reads no `.env`; pass `CANVAS_DROP_*` as
container environment. Boot validates the whole config and exits 1 listing every
problem, for example a `CANVAS_DROP_SESSION_SECRET` shorter than 32 characters.
Bind the port to loopback as above and put a TLS-terminating proxy in front; the
[Deploy](/docs/self-hosting/deploy) page covers what that proxy must do.

### Upgrade the compose stack

Pull, rebuild, restart. Pending migrations run at boot, so the new version applies
its own schema changes. Take a backup first: the app binary doubles as the backup
tool, and the compose stack mounts a dedicated `backups` volume for it.

```bash
docker compose exec -T app sh -lc 'node --conditions=node-dist apps/server/dist/index.js backup /backups/$(date -u +%Y%m%dT%H%M%SZ)'
git pull
docker compose up -d --build
```

`restore <backup-dir>` is the inverse; it refuses a non-empty database without
`--force`. A backup is a cleartext export that includes credential hashes, so keep
it off the data volume and encrypt it before it leaves the host. For scheduled
backups, `docker-compose.yml` carries a commented-out `maintenance` sidecar
(`docker compose --profile maintenance up -d`) that runs the nightly `backup` and
weekly `purge` from `docker/maintenance.cron`. The full runbook is `docs/ops.md`
in the repo; the [Deploy](/docs/self-hosting/deploy) page summarises it under
"Backups and maintenance".

## Run from source

For developing canvas-drop, or for a zero-config local instance. Requires Node 24
or newer and pnpm 11 (`package.json` pins `pnpm@11.0.9`; `corepack enable` selects
it).

```bash
git clone https://github.com/markpasternak/canvas-drop.git
cd canvas-drop
pnpm install
cp .env.example .env
pnpm dev
curl -fsS http://localhost:3000/healthz
# 200 {"status":"ok","db":"ok","version":"..."}
```

`pnpm install` builds `better-sqlite3` natively; the build is pre-approved in
`pnpm-workspace.yaml`, so there is no prompt. (The Docker builder installs
`python3 make g++` for the same reason.)

| URL | What it serves |
|---|---|
| `http://localhost:5173` | The dashboard (Vite dev server with HMR). It proxies `/api`, `/auth`, `/v1`, `/docs`, `/llms.txt`, `/skill.zip`, `/welcome`, and `/og.png` to the server. |
| `http://localhost:3000` | The Hono server: management API, Deploy API, MCP at `/mcp`, docs, and the canvases at `/c/{slug}/`. |

This is the zero-config profile: path URL mode, SQLite at `./data/canvasdrop.db`,
local storage at `./data/storage`, and `dev` auth, which signs every request in as
`dev@example.com` and makes that user the admin. The `data/` directory is created
on first boot. `dev` auth is refused when `NODE_ENV=production`; it is for local
use only.

What `pnpm dev` does:

- Loads `.env` once with `node --env-file-if-exists=.env`. The file is optional
  (the defaults are the dev profile), and variables already in your environment
  win, so `CANVAS_DROP_PORT=3001 pnpm dev` works without editing anything. Nothing
  else reads `.env`; production takes config from the process environment.
- Seeds 100 sample canvases the first time the database has none. Skip with
  `CANVAS_DROP_DEV_SEED=0`; wipe the local database and storage with
  `pnpm reset:data` (stop the dev server first).
- Runs the server (`tsx watch`), the dashboard (`vite`), and the browser SDK build
  (esbuild watch) in parallel. Ctrl-C or `pnpm dev:stop` stops all three.

Ports: `CANVAS_DROP_PORT` moves the server and the Vite proxy target together;
`CANVAS_DROP_DASHBOARD_PORT` moves the Vite server. Neither hops to a free port:
Vite fails when `5173` is taken, and the server exits 1 with a message naming the
bound port. Either usually means a stale dev server is still running
(`pnpm dev:stop`).

The server serves the built dashboard from `apps/dashboard/dist` whenever it
exists, so after `pnpm build` the dashboard also answers on
`http://localhost:3000` (without HMR); before a build, that route returns 503
`dashboard_not_built`. That is the production layout: one process serves the
dashboard, the API, and the canvases. To run it that way without Docker:

```bash
pnpm install --frozen-lockfile
pnpm build
node --conditions=node-dist apps/server/dist/index.js
```

Supply configuration through the process manager (for example systemd
`EnvironmentFile=`), not a `.env` file; only `pnpm dev` reads `.env`. "Running the
bare process" on the [Deploy](/docs/self-hosting/deploy) page covers the proxy in
front.

Next, publish your first canvas: [Quickstart](/docs/quickstart).

## What you choose at install time

Four interfaces, one switch variable each. Every value is validated at boot; a bad
combination fails at startup naming the variable to fix.

| Interface | Switch | Options (default first) | Notes |
|---|---|---|---|
| Database | `CANVAS_DROP_DB` | `sqlite` / `postgres` | `postgres` needs `CANVAS_DROP_DATABASE_URL`. |
| Storage | `CANVAS_DROP_STORAGE` | `local` / `s3` | `s3` needs `CANVAS_DROP_S3_BUCKET`, `CANVAS_DROP_S3_REGION`, `CANVAS_DROP_S3_ACCESS_KEY`, `CANVAS_DROP_S3_SECRET_KEY`, plus `CANVAS_DROP_S3_ENDPOINT` for MinIO or R2. |
| URL mode | `CANVAS_DROP_URL_MODE` | `path` / `subdomain` | `path` serves `{base}/c/{slug}/`; `subdomain` serves `{slug}.{host}` and needs a non-localhost `CANVAS_DROP_BASE_URL`, wildcard DNS, and a wildcard certificate. Set `CANVAS_DROP_API_BASE_URL` only when the Deploy API is fronted on its own host. |
| Auth | `CANVAS_DROP_AUTH_MODE` | `dev` / `proxy` / `oidc` | `dev` is local-only. `proxy` and `oidc` need `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` and a `CANVAS_DROP_SESSION_SECRET` of 32 or more characters; `proxy` also needs a JWKS URL (or `CANVAS_DROP_TRUSTED_PROXY_IPS`). Real auth in `path` mode needs `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true`. |

The recommended production profile is subdomain URLs, `proxy` auth verified
against a JWKS, Postgres, and S3-compatible storage; `.env.production.example` is
that profile, annotated. SQLite, local storage, and path mode stay first-class for
development and small trusted instances.

See [Configuration](/docs/self-hosting/configuration) for every variable, the
[Security model](/docs/self-hosting/security-model) for the trade-offs behind the
auth and URL modes, and [Deploy](/docs/self-hosting/deploy) for the production
walkthrough.

# Configuration

If you run a canvas-drop instance, this is the environment-variable reference: every
variable the server reads, its default, and what refuses to boot when it is wrong. Every
setting is an environment variable, validated once at startup. One module
(`packages/shared/src/config/env.ts`) is the only reader of `process.env`; everything else
takes typed config. An invalid value or combination fails at boot with a message naming
every variable to fix, never at request time. Nothing is reported anywhere: no telemetry,
no phone-home.

The defaults below are the schema defaults. `.env.example` mirrors them with comments;
`.env.production.example` is the annotated production profile.

## How config gets loaded

**Local dev.** `pnpm dev` reads the root `.env` file once (`node --env-file-if-exists=.env`).
Copy the template and start:

```bash
cp .env.example .env && pnpm dev
# server on http://localhost:3000, dashboard on http://localhost:5173, signed in as dev@example.com
```

The defaults give you a logged-in instance: `path` URLs, `sqlite`, `local` storage, `dev` auth.

**Production.** The `.env` file is not read. Set variables in the process environment: a
systemd `EnvironmentFile`, the container `environment:` block, or a secrets manager. The
recommended profile (subdomain URLs, `proxy` auth verified against a JWKS, Postgres, S3)
needs this set; everything else keeps its default:

```bash
NODE_ENV=production
CANVAS_DROP_URL_MODE=subdomain
CANVAS_DROP_BASE_URL=https://canvases.example.com
CANVAS_DROP_SESSION_SECRET=<output of: openssl rand -hex 32>

CANVAS_DROP_AUTH_MODE=proxy
CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL=https://idp.example.com/.well-known/jwks.json
CANVAS_DROP_AUTH_PROXY_JWT_ISSUER=https://idp.example.com
CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE=canvas-drop
CANVAS_DROP_ALLOWED_EMAIL_DOMAINS=example.com
CANVAS_DROP_ADMIN_EMAILS=admin@example.com

CANVAS_DROP_DB=postgres
CANVAS_DROP_DATABASE_URL=postgres://canvasdrop:<password>@db.internal:5432/canvasdrop

CANVAS_DROP_STORAGE=s3
CANVAS_DROP_S3_BUCKET=canvas-drop
CANVAS_DROP_S3_REGION=us-east-1
CANVAS_DROP_S3_ACCESS_KEY=<access key>
CANVAS_DROP_S3_SECRET_KEY=<secret key>
```

A misconfigured start prints every problem at once and exits with status 1:

```text
Invalid canvas-drop configuration:
  - CANVAS_DROP_SESSION_SECRET: a session secret of at least 32 characters is required outside dev mode (and always in production)
  - CANVAS_DROP_DATABASE_URL: CANVAS_DROP_DATABASE_URL is required when CANVAS_DROP_DB=postgres

Fix the variables above (see .env.example) and restart.
```

**Docker image.** The image presets `NODE_ENV=production`, `CANVAS_DROP_PORT=3000`,
`CANVAS_DROP_SQLITE_PATH=/data/canvasdrop.db`, `CANVAS_DROP_STORAGE_PATH=/data/storage`, and
`CANVAS_DROP_DASHBOARD_DIST=/app/apps/dashboard/dist`, with `/data` as the volume. Everything
else comes from the environment you pass in. See [Deploy](/docs/self-hosting/deploy).

**Admin view.** Admin → Configuration lists the main settings with their source: Environment,
Default, or a DB override. Secrets render as set or unset plus the last four characters. A
few settings can be edited there at runtime (a DB override layered over env); the tables below
mark them **runtime-editable**. Everything else is env-only by design: a web panel must not be
able to flip the auth mode, the database driver, or the session secret. A handful of env-only
knobs are not shown in the panel at all (`CANVAS_DROP_MCP`, `CANVAS_DROP_DASHBOARD_DIST`, the
screenshot tuning values, the proxy header names, `CANVAS_DROP_ORG_*`,
`CANVAS_DROP_S3_FORCE_PATH_STYLE`, `CANVAS_DROP_DEV_USER_*`, and the authoring share policy).

## Value formats

| Format | Accepted values |
|--------|-----------------|
| enum | exactly one of the listed tokens, e.g. `on` or `off` |
| CSV | comma-separated; entries trimmed, empty entries dropped |
| boolean | `1`, `true`, `on`, `yes` or `0`, `false`, `off`, `no` (case-insensitive); anything else fails boot |
| number | any finite number |
| integer ≥ 1 | rate limits and screenshot tuning; `0` or a negative value fails boot (use the `_ENABLED` switch to turn a class off) |
| integer ≥ 0 | `CANVAS_DROP_PUBLIC_EDGE_CACHE_TTL` |
| URL | an absolute URL with a scheme (`CANVAS_DROP_BASE_URL`, JWKS, OIDC issuer, AI and Mailgun base URLs) |

An empty value counts as unset and takes the default.

## Boot-time checks

These combinations are enforced at startup, in addition to each variable's format:

- `CANVAS_DROP_AUTH_MODE=dev` with `NODE_ENV=production` refuses to start.
- `CANVAS_DROP_URL_MODE=subdomain` needs a non-localhost `CANVAS_DROP_BASE_URL` (`localhost`, `127.0.0.1`, `::1`, and `*.localhost` are rejected).
- `CANVAS_DROP_SESSION_SECRET` must be at least 32 characters whenever the auth mode is not `dev`, and always when `NODE_ENV=production`.
- `CANVAS_DROP_DB=postgres` requires `CANVAS_DROP_DATABASE_URL`.
- `CANVAS_DROP_STORAGE=s3` requires `CANVAS_DROP_S3_BUCKET`, `CANVAS_DROP_S3_REGION`, `CANVAS_DROP_S3_ACCESS_KEY`, and `CANVAS_DROP_S3_SECRET_KEY`.
- Every `CANVAS_DROP_TRUSTED_PROXY_IPS` entry is validated, in every auth mode.
- `proxy` auth requires `CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL` or a non-empty `CANVAS_DROP_TRUSTED_PROXY_IPS`; with a JWKS URL, `CANVAS_DROP_AUTH_PROXY_JWT_ISSUER` and `CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE` are required too.
- `oidc` auth requires `CANVAS_DROP_OIDC_ISSUER`, `CANVAS_DROP_OIDC_CLIENT_ID`, and `CANVAS_DROP_OIDC_CLIENT_SECRET`.
- Any auth mode other than `dev` requires at least one `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` entry.
- `path` URL mode with `proxy` or `oidc` auth requires `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true`.

Tenancy adds three more once `CANVAS_DROP_ORG_NAME` is set; see
[Tenancy](#tenancy-the-org-boundary-optional).

## The four pluggable interfaces

Each interface is selected by one switch variable. Swapping a driver is a config change, never
a code change. Migrations run at boot on whichever database is selected, and a backup taken on
one driver restores onto another (see
[Backups and maintenance](/docs/self-hosting/deploy#backups-and-maintenance)).

| Interface | Switch | Options (default first) | Driver-specific vars |
|-----------|--------|-------------------------|----------------------|
| Database | `CANVAS_DROP_DB` | `sqlite` / `postgres` | sqlite: `CANVAS_DROP_SQLITE_PATH`; postgres: `CANVAS_DROP_DATABASE_URL` |
| Storage | `CANVAS_DROP_STORAGE` | `local` / `s3` | local: `CANVAS_DROP_STORAGE_PATH`; s3: `CANVAS_DROP_S3_*` (any S3-compatible store via a custom endpoint) |
| URL mode | `CANVAS_DROP_URL_MODE` | `path` / `subdomain` | `CANVAS_DROP_BASE_URL` (non-localhost for subdomain); optional `CANVAS_DROP_API_BASE_URL`; `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE` for path mode with real auth |
| Auth | `CANVAS_DROP_AUTH_MODE` | `dev` / `proxy` / `oidc` | dev: `CANVAS_DROP_DEV_USER_*`; proxy: JWT vars or trusted-header vars; oidc: `CANVAS_DROP_OIDC_*`; both real modes: `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS`, `CANVAS_DROP_SESSION_SECRET` |

Email transport (`CANVAS_DROP_EMAIL_DRIVER`) is a fifth, smaller driver seam; see
[Email transport](#email-transport).

## Core

| Variable | Default | Notes |
|----------|---------|-------|
| `NODE_ENV` | `development` | `development` \| `production` \| `test`. `production` forbids `dev` auth, makes the session secret mandatory, and switches the `LOG_FORMAT` default to `json`. |
| `CANVAS_DROP_URL_MODE` | `path` | `path` serves canvases at `{base}/c/{slug}/`; `subdomain` serves `{slug}.{baseHost}` and gives each canvas its own origin. |
| `CANVAS_DROP_BASE_URL` | `http://localhost:3000` | Public origin of the instance. Must be non-localhost in `subdomain` mode. The app never reads `X-Forwarded-Proto`; behind TLS this must be the `https://` origin. |
| `CANVAS_DROP_API_BASE_URL` | (= `CANVAS_DROP_BASE_URL`) | Where the Deploy API (`/v1/canvases/*`) is reachable. Set it only when the API is fronted on its own host, e.g. canvases at `{slug}.canvases.example.com` and the API at `https://api.canvases.example.com`. MCP tools advertise endpoints built from this value, so agents never probe for the host. |
| `CANVAS_DROP_PORT` | `3000` | Listen port. |
| `CANVAS_DROP_SESSION_SECRET` | (insecure dev fallback) | **Required, at least 32 characters, outside `dev` auth and always in production.** HMAC key for password-gate cookies and screenshot capture tokens. Session cookies (`oidc`, `dev`) are random tokens stored hashed in the database, not derived from it. Generate with `openssl rand -hex 32`. |
| `CANVAS_DROP_ADMIN_EMAILS` | (empty; in `dev` auth, the dev user) | CSV, lowercased. Bootstrap admins: these accounts get the admin surface. |
| `CANVAS_DROP_REALTIME` | `on` | `on` \| `off`. Master switch for the realtime primitive. |
| `CANVAS_DROP_MCP` | `on` | `on` \| `off`. When `off`, the `/mcp` and OAuth routes are not mounted at all. |
| `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE` | `false` | boolean. Must be `true` to boot `path` mode with `proxy` or `oidc` auth: several users then share one origin, so browser isolation is reduced. See [Path mode vs subdomain mode](/docs/self-hosting/security-model#path-mode-vs-subdomain-mode-invariant-4). |
| `CANVAS_DROP_DASHBOARD_DIST` | (resolved from the server module) | Path to the built dashboard SPA. The Docker image sets `/app/apps/dashboard/dist`. |
| `CANVAS_DROP_PUBLIC_EDGE_CACHE_TTL` | `300` | integer ≥ 0, seconds. How long a shared cache (a CDN in front) may hold a **public** canvas's HTML, emitted as `s-maxage`; the browser still revalidates every load. Only the Public link rung without a password is ever shared-cacheable; auth-gated canvases stay `private`. It is also how long a canvas can stay visible at the edge after access is restricted, and the dashboard warns owners with this figure. `0` disables shared caching. See [Behind a CDN](/docs/self-hosting/cdn). |
| `CANVAS_DROP_DESIGN_SKIN` | `editorial` | `editorial` \| `studio` \| `workshop` \| `canvas`. Instance-wide visual language. **Runtime-editable**; a DB override wins over this value. See [Design skins](#design-skins). |

Admin → Configuration also carries `core.instanceName`, a DB-only display name (default: the
host of `CANVAS_DROP_BASE_URL`) for custom email templates that still use `{{instanceName}}`.
The seeded templates name the recipient email, the inviter, and the specific canvas, team, or
sign-in action instead of instance or org branding.

## Design skins

A design skin is an instance-wide visual language: the dashboard, the editor, the signed-out
landing page, the docs, and the legal pages all change together. It is a token-only layer over
the brand tokens: a skin overrides the accent colour family, the display-type bundle (font,
weight, tracking), and the corner-radius scale. No skin forks layout or structure. Error pages
keep the default look.

| Skin | Accent | Display type | Corners | Feel |
|------|--------|--------------|---------|------|
| `editorial` (default) | deep teal | Newsreader serif, weight 500 | 1× | Calm publishing OS; the base look. |
| `studio` | terracotta | Newsreader serif, weight 500 | 1× | Warm editorial. |
| `workshop` | green | Geist Mono, weight 500 | 0.62× (tighter) | Developer / IDE. |
| `canvas` | violet | Geist sans, weight 800 | 1.3× (rounder) | Playful, bold. |

Accent lightness is kept conservative in every skin so the accent foreground clears WCAG AA on
the fill in light and dark mode.

Two ways to set it, with the same effect for everyone on the instance:

- **Admin console.** Admin → Configuration → Design skin. Changing the dropdown previews the
  skin live in your own session; **Save** writes the override to the database and applies it to
  all users at runtime, with no restart. Leaving the page without saving reverts your preview.
- **`CANVAS_DROP_DESIGN_SKIN`.** The boot default. A DB override set in the console always
  wins over this value; **Clear** in the console removes the override and falls back to it.

The skin is global and admin-only. It is not a per-user preference; light or dark theme is the
per-user setting.

## Auth

`CANVAS_DROP_AUTH_MODE` selects how identity is established. Identity always comes from the
server-side auth strategy, never from anything the client sends. In every mode the same checks
run on every request: the email must pass the domain allowlist (or a sign-in permit), the user
must not be blocked, and org membership is derived from the verified email domain. See
[Security model](/docs/self-hosting/security-model).

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_AUTH_MODE` | `dev` | `dev` \| `proxy` \| `oidc`. `dev` is **rejected when `NODE_ENV=production`**. |
| `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS` | (empty; in `dev` auth, the dev user's domain) | CSV, lowercased. **Required (at least one) in `proxy` and `oidc`.** Enforced on every request. |

> **Sign-in permits.** Beyond the domain list, an admin can permit specific outside emails to
> sign in (a contractor, a test account) under Admin → People → Sign-in permits. It is an
> additive, DB-managed layer: the env domain list is unchanged, and an email passes if its
> domain is allowed **or** it is on this list. There is no app-owned password; adding an email
> sends a sign-in invitation (when access emails are on), and removing an entry revokes that
> email's access on its next sign-in. In `proxy` mode this list cannot widen the upstream IAP
> by itself, and no email is sent: admit a brand-new external email in the proxy first, then
> add it here. See [Sign-in permits and access emails](#sign-in-permits-and-access-emails).

### dev mode

Auto-logs-in a fixed local user with zero setup; no credential is examined. A session cookie
still exists so `/auth/logout` works. Localhost only; production refuses to boot in this mode.

| Variable | Default |
|----------|---------|
| `CANVAS_DROP_DEV_USER_EMAIL` | `dev@example.com` |
| `CANVAS_DROP_DEV_USER_NAME` | `Dev User` |

### oidc mode

The app owns login: Authorization Code with PKCE against your provider, then an `HttpOnly`
session cookie (`__canvasdrop_session`, 14-day rolling expiry, `SameSite=Lax`, `Secure` in
production, `Domain=.{baseHost}` in subdomain mode, host-only in path mode). An
unauthenticated request is redirected to `/auth/login`. Use this when no identity-aware proxy
fronts the app.

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_OIDC_ISSUER` | (unset) | **Required.** Provider issuer URL (discovery runs against it). |
| `CANVAS_DROP_OIDC_CLIENT_ID` | (unset) | **Required.** |
| `CANVAS_DROP_OIDC_CLIENT_SECRET` | (unset) | **Required.** |

### proxy mode

Front the app with an identity-aware proxy that asserts identity on every request. The app
issues no session cookie; an unauthenticated request gets `401`. Exactly **one** trust path is
active, selected by whether `CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL` is set. They do not compose:
when the JWKS URL is set, identity headers are never honored, even if they arrive (their
arrival is logged as a downgrade probe). Boot fails if neither path is configured.

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_AUTH_PROXY_JWT_HEADER` | `Cf-Access-Jwt-Assertion` | Header carrying the proxy's signed JWT (JWKS path). The default is the header name Cloudflare Access sends; the bundled compose demo sets `X-Forwarded-Access-Token` for oauth2-proxy. |
| `CANVAS_DROP_AUTH_PROXY_JWT_JWKS_URL` | (unset) | Enables the JWKS path: the JWT's signature, `iss`, `aud`, and expiry are verified against this key set on every request. The `email` claim is required. |
| `CANVAS_DROP_AUTH_PROXY_JWT_ISSUER` | (unset) | **Required when the JWKS URL is set.** |
| `CANVAS_DROP_AUTH_PROXY_JWT_AUDIENCE` | (unset) | **Required when the JWKS URL is set.** |
| `CANVAS_DROP_AUTH_PROXY_EMAIL_HEADER` | `X-Auth-Request-Email` | Identity header (trusted-header path). The default is the header oauth2-proxy sends. |
| `CANVAS_DROP_AUTH_PROXY_NAME_HEADER` | `X-Auth-Request-Preferred-Username` | Display-name header (trusted-header path). |
| `CANVAS_DROP_TRUSTED_PROXY_IPS` | (empty) | CSV of IPv4 addresses or CIDRs (`/1` to `/32`). Enables the trusted-header path when no JWKS URL is set: identity headers are honored only when the TCP socket peer is in this list (never based on `X-Forwarded-For`). Each entry is validated at boot in every mode: `/0`, malformed IPv4, and IPv6 are rejected (use the JWKS path for IPv6 proxies). Set it in `oidc` mode too, to your proxy's egress, so login throttling and audit rows are keyed per client rather than per proxy. See [Behind a CDN](/docs/self-hosting/cdn). |
| `CANVAS_DROP_CLIENT_IP_HEADER` | (unset) | Header carrying the real client IP behind a CDN (for example `True-Client-IP`; name whatever your CDN sends). Read **only** when the socket peer is a trusted proxy above, so it cannot be spoofed. When unset, the rightmost untrusted `X-Forwarded-For` hop is used. This IP keys rate limits and audit rows; it is never an auth input. |

The proxy must be the only way to reach the app, and it must overwrite the identity headers it
forwards. See [Auth at the edge](/docs/self-hosting/deploy#auth-at-the-edge).

## Tenancy: the org boundary (optional)

Names an org so that guests (people who sign in on a non-org domain: a contractor, a personal
address, an admin on another domain) cannot see canvases shared with the Whole org rung.
Membership is derived server-side from the user's verified email domain; a member can home a
canvas in the org, a guest only ever gets Personal.

Off by default. With no `CANVAS_DROP_ORG_NAME` the feature is inert: Whole org keeps its legacy
"any signed-in user" meaning and the home org is ignored everywhere. Setting the name turns it
on, so you can deploy first and migrate later.

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_ORG_NAME` | (unset) | The org's display name, trimmed. **Setting this turns tenancy on.** Unset or blank = inert. |
| `CANVAS_DROP_ORG_DOMAINS` | (= `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS`) | CSV of member domains, lowercased ASCII (list IDNs in punycode form). Defaults to the sign-in domain allowlist, the common single-org case. |

At boot the instance materializes the org and its domains idempotently. The configured domain
set is authoritative: a domain you remove is pruned at the next boot, and its users drop to
guest on their next request. Boot fails on a bad config: a domain mapped to two orgs, more than
one org (multi-org is a later phase), or an org with no domains. Migrating an existing instance
(homing current canvases, clamping guest-owned Whole org rows) is a one-time cutover with a
read-only dry run: `pnpm tenancy:plan`, then `pnpm tenancy:plan --apply`. After narrowing
`CANVAS_DROP_ORG_DOMAINS`, `pnpm tenancy:reconcile --apply` revokes the stale domain-sourced
memberships. The runbook is `docs/tenancy.md` in the repo.

## Database

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_DB` | `sqlite` | `sqlite` \| `postgres`. |
| `CANVAS_DROP_SQLITE_PATH` | `./data/canvasdrop.db` | SQLite file path (WAL mode). The Docker image sets `/data/canvasdrop.db`. |
| `CANVAS_DROP_DATABASE_URL` | (unset) | **Required when `CANVAS_DROP_DB=postgres`.** Standard `postgres://` connection string. |

Migrations run at boot on the selected database; there is no separate migrate command.

## Storage

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_STORAGE` | `local` | `local` \| `s3`. |
| `CANVAS_DROP_STORAGE_PATH` | `./data/storage` | Local storage root. The Docker image sets `/data/storage`. |
| `CANVAS_DROP_S3_ENDPOINT` | (unset; the provider's default) | Custom endpoint for a self-hosted or non-AWS S3-compatible store. |
| `CANVAS_DROP_S3_BUCKET` | (unset) | **Required when `CANVAS_DROP_STORAGE=s3`.** The bucket must already exist. |
| `CANVAS_DROP_S3_REGION` | (unset) | **Required when `s3`.** |
| `CANVAS_DROP_S3_ACCESS_KEY` | (unset) | **Required when `s3`.** |
| `CANVAS_DROP_S3_SECRET_KEY` | (unset) | **Required when `s3`.** |
| `CANVAS_DROP_S3_FORCE_PATH_STYLE` | `true` | boolean. Keep `true` for path-style stores such as MinIO. |

## Screenshots (optional)

Generates canvas preview thumbnails with headless Chromium. The pipeline is off by default and
needs two things: Chromium in the image (build with `--build-arg SCREENSHOTS=1`) and
`CANVAS_DROP_SCREENSHOTS=on`. The env var only sets availability; an admin still turns capture
on under Admin → Configuration (`screenshots.enabled`, **runtime-editable**, default off).
Effective = available and enabled. Each tuning var is an integer ≥ 1. See
[Screenshots](/docs/self-hosting/screenshots).

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_SCREENSHOTS` | `off` | `on` \| `off`. Availability switch. |
| `CANVAS_DROP_SCREENSHOTS_CONCURRENCY` | `1` | Concurrent render workers. |
| `CANVAS_DROP_SCREENSHOTS_TIMEOUT_MS` | `20000` | Per-render timeout. |
| `CANVAS_DROP_SCREENSHOTS_RECYCLE_EVERY` | `50` | Renders before a worker is recycled. |
| `CANVAS_DROP_SCREENSHOTS_LEASE_MS` | `120000` | Job lease duration. |
| `CANVAS_DROP_SCREENSHOTS_MAX_ATTEMPTS` | `3` | Attempts before a job is marked failed. |
| `CANVAS_DROP_SCREENSHOTS_FAILED_TTL_MS` | `86400000` | How long a failed job is retained (24 h). |
| `CANVAS_DROP_SCREENSHOTS_TOKEN_TTL_MS` | `60000` | Render-token lifetime. |

## Rate limiting

Per-minute request budgets, applied per class with in-process counters over a fixed 60-second
window. Env-only: they are read on the hot path and are shown read-only in Admin →
Configuration. Each limit is an integer ≥ 1; boot fails on `0` or a negative value, so use the
master switch to disable limiting.

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_RATELIMIT_ENABLED` | `true` | boolean. Master switch. |
| `CANVAS_DROP_RATELIMIT_CANVAS_API_PER_MIN` | `120` | Canvas Runtime API. |
| `CANVAS_DROP_RATELIMIT_AI_PER_MIN` | `10` | AI proxy calls. |
| `CANVAS_DROP_RATELIMIT_DEPLOY_PER_MIN` | `10` | Deploy API, keyed per canvas, applied after key verification. |
| `CANVAS_DROP_RATELIMIT_MANAGEMENT_PER_MIN` | `120` | Dashboard management routes. |
| `CANVAS_DROP_RATELIMIT_LOGIN_PER_MIN` | `10` | Keyed on the resolved client IP. |
| `CANVAS_DROP_RATELIMIT_PASSWORD_GATE_PER_MIN` | `5` | Password attempts on gated canvases. |

## AI (optional)

The AI primitive is off until a provider key is present, from `CANVAS_DROP_AI_API_KEY` or a
runtime override. The key is server-side only and never reaches the browser. An empty or
whitespace value counts as unset.

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_AI_PROVIDER` | `anthropic` | |
| `CANVAS_DROP_AI_API_KEY` | (unset) | **Runtime-editable** (write-only in the admin view). Unset or blank disables AI. |
| `CANVAS_DROP_AI_BASE_URL` | (unset) | Override the provider base URL. |
| `CANVAS_DROP_AI_MODELS` | `claude-haiku-4-5,claude-sonnet-4-6,claude-opus-4-8` | CSV allowlist of model ids canvases may call. **Runtime-editable.** |
| `CANVAS_DROP_AI_USER_DAILY_USD` | `5` | Per-user daily spend cap. **Runtime-editable.** |
| `CANVAS_DROP_AI_CANVAS_MONTHLY_USD` | `50` | Per-canvas monthly spend cap. **Runtime-editable.** |

## Authoring (optional)

The authoring capability lets a signed-in viewer create a new canvas from a backend-enabled
canvas's page, as themselves. It is higher-privilege than the other primitives, so it is off
instance-wide by default and the per-canvas Backend toggle also defaults off; both must be on.
The share policy (the last three rows) is env-only.

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_AUTHORING` | `off` | `on` \| `off`. Instance master switch. **Runtime-editable.** |
| `CANVAS_DROP_AUTHORING_USER_DAILY_MAX` | `20` | Max canvases a viewer may author per UTC day. **Runtime-editable.** |
| `CANVAS_DROP_AUTHORING_USER_TOTAL_MAX` | `200` | All-time cap per viewer. **Runtime-editable.** |
| `CANVAS_DROP_AUTHORING_ALLOWED_RUNGS` | `private,specific_people,whole_org,public_link` | CSV of `access` values a publish may request (`specific_people` is a legacy alias of `private`). `public_link` also covers the SDK's `access: "password"`. |
| `CANVAS_DROP_AUTHORING_MAX_EXPIRY_DAYS` | `0` | Max share expiry in days; `0` = no cap. |
| `CANVAS_DROP_AUTHORING_REQUIRE_EXPIRY` | `false` | boolean. Require an expiry on shared rungs. |

## Email transport

Sends the auth-delegated sign-in and access emails for account, canvas, and team access. It is
a driver behind an interface, like the database and storage. Provider secrets are env-only,
never DB-overridable, and never logged.

**`proxy` mode sends no email.** The mailer is not built in that mode (the IAP owns sign-in),
so every sign-in or access email is skipped; grants still happen. The variables below apply to
`dev` and `oidc`.

A driver that cannot send skips the email rather than failing the grant: `smtp` needs a host,
`mailgun` needs an API key and a domain, `noop` never sends, `log` always "sends" (to the log).

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_DROP_EMAIL_DRIVER` | `log` | `log` (writes the message to the server log, nothing delivered; zero-setup dev) \| `smtp` \| `mailgun` \| `noop` (discards). |
| `CANVAS_DROP_EMAIL_FROM` | `no-reply@<CANVAS_DROP_MAILGUN_DOMAIN>` when that is set, else `no-reply@localhost` | Sender address. |
| `CANVAS_DROP_SMTP_HOST` | (unset) | SMTP server host (driver `smtp`). Not checked at boot; without it every email is skipped. |
| `CANVAS_DROP_SMTP_PORT` | `587` | `587` = STARTTLS, `465` = implicit TLS. |
| `CANVAS_DROP_SMTP_USER` / `CANVAS_DROP_SMTP_PASS` | (unset) | Omit both for an IP-allowlisted relay; auth is sent only when both are present. |
| `CANVAS_DROP_SMTP_SECURE` | `false` | boolean. `true` for implicit TLS (port 465). |
| `CANVAS_DROP_MAILGUN_API_KEY` | (unset) | Mailgun HTTP API key (driver `mailgun`). |
| `CANVAS_DROP_MAILGUN_DOMAIN` | (unset) | e.g. `mg.example.com`. |
| `CANVAS_DROP_MAILGUN_BASE_URL` | `https://api.mailgun.net` | Use `https://api.eu.mailgun.net` for EU accounts. |

<a id="add-users--invites"></a>

## Sign-in permits and access emails

These are DB-managed admin settings with no env var, under Admin → Configuration, layered on
top of the mailer above. They govern the
[auth-delegated add-person flow](/docs/self-hosting/security-model#adds-are-auth-delegated-no-app-owned-credentials):
personal-team adds, canvas Add person, and admin sign-in permits.

| Setting | Default | Notes |
|---------|---------|-------|
| `email.invitesEnabled` | `false` | Master switch. When off, grants still happen but no sign-in or access email is sent. Also needs a driver that can send (see above). |
| `email.notifyOnAddUser` | `true` | Email a person when an admin permits their email to sign in. |
| `email.notifyOnCanvasAdd` | `true` | Email an existing user when added to a canvas's people-and-teams list. |
| `email.notifyOnCanvasInvite` | `true` | Email an existing user on an individual one-canvas access action. |
| `invites.allowMemberNewEmails` | `false` | Let a non-admin member add a brand-new external email. Off = only admins can permit new emails; members can add people who can already sign in. |
| `invites.maxPerActorPerHour` | `20` | Add-person actions per actor per hour (admins get a higher allowance). |
| `invites.pendingCap` | `50` | Max unconsumed pending sign-ins one actor may hold. |
| `access.publicLinksEnabled` | `true` | Instance-wide switch for the Public link rung. Off denies new public-link publishes and returns existing public-link canvases to private. |

Adding a brand-new person to a team or canvas sends them the sign-in invitation, gated only by
the master switch and the mailer; existing team members are not re-notified.

Admin → Configuration also holds the runtime quotas for the KV and files primitives, with no
env var: `quota.kv.keys.shared` (default `10000` shared keys per canvas), `quota.kv.keys.user`
(`1000` per-user keys), `quota.files.bytes.file` (`26214400`, 25 MB per file), and
`quota.files.bytes.canvas` (`1073741824`, 1 GB per canvas).

Email templates for each message are admin-editable (subject, HTML, text) under Admin →
Configuration → Email templates, with `{{variable}}` substitution from an allow-list (`name`,
`recipientEmail`, `inviterName`, `canvasTitle`, `teamName`, `link`, `role`, `accessLabel`,
`personEmail`, `reason`, plus the legacy `instanceName`, `orgName`, `orgContext`) and a reset to
the latest default. Values are HTML-escaped in the HTML body; an unknown variable renders empty.

## Logging and error tracking

Structured logs go to stdout via pino: no app-side files, rotation, or shipping. `/healthz` is
excluded from request logging.

| Variable | Default | Notes |
|----------|---------|-------|
| `LOG_LEVEL` | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`. |
| `LOG_FORMAT` | `json` when `NODE_ENV=production`, else `pretty` | `json` \| `pretty`. `pretty` runs pino-pretty in-process; use it for local dev only. |
| `CANVAS_DROP_SENTRY_DSN` | (unset) | Accepted and shown in Admin → Configuration, but the server ships no Sentry client today: setting it sends nothing. Error tracking is off. |

## Tooling-only variables

A few `CANVAS_DROP_*` names in the repo are read by scripts and tests, not by the server, and
are not part of the config schema:

| Variable | Read by | Purpose |
|----------|---------|---------|
| `CANVAS_DROP_DEV_SEED` | `pnpm dev` | `0` skips the sample-canvas seed. |
| `CANVAS_DROP_DASHBOARD_PORT` | the dashboard's Vite dev server | Dev port (default `5173`). |
| `CANVAS_DROP_DASHBOARD_URL` | `pnpm docs:screenshots`, `pnpm skins:shot` | Dashboard base for Playwright captures (default `http://localhost:5173`). |
| `CANVAS_DROP_DB` (in tests) | `pnpm test:sqlite`, `pnpm test:pg` | When set, the suite runs only that dialect; unset runs both in-process. |
| `CANVAS_DROP_TEST_*` | the test runner and CI | Run isolation (`_RUN_ID`, `_MAX_WORKERS`, `_REGISTRY_DIR`), the real Postgres and MinIO smoke tests (`_DATABASE_URL`, `_S3_*`), and the opt-in Chromium capture test (`_SCREENSHOTS=1`). |

> All examples use placeholder values. Never commit real secrets; set them in your deployment
> environment (systemd, container env, secrets manager).

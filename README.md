# canvas-drop

**Drop a folder of HTML in. Get a secure, shareable URL out — in seconds.**

canvas-drop is a self-hostable platform where authenticated members of an organization deploy and share small static web artifacts (**"canvases"**) and, when they need a backend, reach for five built-in primitives instead of standing up infrastructure. It is open-source (MIT), deployment-agnostic, and carries **no telemetry and no phone-home**.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/markpasternak/canvas-drop/actions/workflows/ci.yml/badge.svg)](https://github.com/markpasternak/canvas-drop/actions/workflows/ci.yml)
![Node 24](https://img.shields.io/badge/node-%3E%3D24-3c873a.svg)

People now generate working web interfaces in minutes with AI — but there's nowhere safe and instant to put them. canvas-drop closes that gap. It's not a hosting platform; it's an organization's **creation-and-sharing layer** for AI-generated tools, prototypes, dashboards, demos, and lightweight internal apps. The strategic value is cultural: more working artifacts, fewer screenshots and slide decks, less waiting on engineering for every small internal tool.

```
   write or generate          drag a folder · paste HTML · POST it
   a small web app   ───────▶  canvas-drop  ───────▶  https://quiet-otter-x7k2.canvases.example.com
                                   │                   (unguessable URL, inside your org's trust boundary)
                                   └── need a backend? kv · files · ai · identity · realtime — zero config
```

---

## Why it's different

- **Idea → live URL in under 60 seconds.** No cloud, CI/CD, DNS, TLS, secrets, or database to understand. Four deploy paths: drag a folder, upload a ZIP, paste HTML, or `PUT` it from a script.
- **Private by default, inside your org.** Every request is authenticated. Canvases are owner-only until *explicitly* shared; shares are revocable and optionally time-boxed. URLs are unguessable random slugs.
- **Static-first, backend-optional.** A canvas is just static files — no build step, ever. Backend capability arrives only through five fixed primitives, added to a page with one `<script>` tag and **no secrets in the browser**.
- **AI agents are first-class authors.** Canvas code runs zero-config, the deploy API ships from day one, and the SDK contract lives on one agent-readable page (`/llms.txt`). An agent can write a canvas and ship it with no human in the loop.
- **Run anywhere.** Database, storage, URL mode, and auth all sit behind interfaces. The same image runs on a laptop, a $5 VPS, or a corporate cloud — swapping any driver is a config change, never a code change.
- **The constraint is the product.** A small, fixed set of primitives done extremely well, deliberately smaller than Heroku/Vercel/Firebase/Retool. It gets very good at saying no.

---

## Quickstart (local dev)

Requires **Node 24** and **pnpm**. Clone → running instance in well under five minutes:

```bash
git clone https://github.com/markpasternak/canvas-drop.git
cd canvas-drop
pnpm install
cp .env.example .env       # defaults: path mode · SQLite · local storage · dev auth
pnpm dev                   # starts server + dashboard in watch mode (Ctrl-C to stop both)
```

Then open:

| URL | What |
|-----|------|
| **http://localhost:5173** | The **dashboard** with hot-reload (Vite HMR for the frontend, `tsx watch` restarts the server on backend changes). Develop here — it proxies `/api`, `/auth`, and `/v1` to the server. |
| **http://localhost:3000** | The **Hono server**: the API, deploy endpoints, and hosted canvases. |

`dev` auth auto-logs-in a fake local user — zero setup. To sign in as yourself, set `CANVAS_DROP_DEV_USER_EMAIL` in `.env`. Check the server is alive:

```bash
curl http://localhost:3000/healthz      # → {"status":"ok","db":"ok","version":"0.0.0"}
```

> **Port already in use?** An `EADDRINUSE` on :3000 (or a strict-port error on :5173) means a previous dev server is still running:
> ```bash
> lsof -nP -iTCP:3000 -sTCP:LISTEN     # note the PID, then: kill <PID>
> ```
> Or run elsewhere: `CANVAS_DROP_PORT=3001 pnpm dev`.

---

## Publishing a canvas

Every publish produces the same thing: an immutable version served at an unguessable URL. The first three are in the dashboard; the fourth is for scripts and agents.

1. **Drag a folder or ZIP** — drop `index.html` and its assets onto the create flow.
2. **Paste HTML** — for a single-file artifact (often what an AI just wrote for you).
3. **Edit in the browser** — a file manager + CodeMirror editor work against a mutable **draft** with autosave; an explicit **Publish** snapshots the draft into an immutable version and makes it the current one. One click switches the current version to any of the last 10.
4. **Deploy API** — `PUT` a ZIP with the canvas's secret key. `deploy = live`: this publishes a version directly, no draft loop. ("Deploy" is the API/CLI term for publishing from files.)

```bash
curl -X PUT "$BASE_URL/v1/canvases/$CANVAS_ID/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
```

The key operates only on its own canvas and **never belongs in canvas files**. `GET /v1/canvases/:id`, `GET …/versions`, and `POST …/rollback` round out the programmatic surface — the future CLI and agent skills are thin clients of exactly this.

Storage is **content-addressed**: blobs are keyed by hash, versions and drafts are manifests over shared blobs, so only changed files are ever written and re-uploads are cheap.

You can also **clone** an existing canvas as a starting point — any active canvas you own, or a gallery-listed template someone else marked as cloneable. The copy starts as an unpublished draft with a fresh slug and key, backend off.

---

## Backend in five primitives

Add one tag — no build step, no keys, no config:

```html
<script src="/sdk/v1.js"></script>
```

The global `canvasdrop` appears. Identity rides the signed-in session; the canvas is identified from its own URL. Every method throws a typed, `instanceof`-catchable error (`CapabilityDisabledError`, `QuotaExceededError`, `NotFoundError`, `NotAuthenticatedError`).

```js
// Identity — who's viewing, straight from the server-side auth context
const me = await canvasdrop.me();                  // { id, email, name, avatarUrl }

// KV — canvas-global, or auto-scoped per viewer; atomic increment for polls/counters
const votes = await canvasdrop.kv.increment("votes", 1);
await canvasdrop.kv.user.set("theme", "dark");

// Files — upload, list, link, delete (served as safe attachments, never executed)
const f = await canvasdrop.files.upload(input.files[0]);   // { id, name, size, url }

// AI — server-side proxy, streaming SSE, admin allowlist + per-user/canvas quotas
for await (const delta of canvasdrop.ai.stream(messages, { model }))
  output.textContent += delta;

// Realtime — ephemeral pub/sub + presence; one auto-reconnecting socket per canvas
const ch = canvasdrop.realtime.channel("room");
ch.subscribe((msg) => render(msg));
ch.publish("cursor", { x, y });
```

| Primitive | What it gives a canvas |
|-----------|------------------------|
| **KV** | Shared (`kv.*`) and per-viewer (`kv.user.*`) key/value with `list` + atomic `increment`. |
| **Files** | Per-canvas file upload/list/delete; served as safe, non-executable bytes. |
| **AI** | Anthropic-first proxy behind a provider abstraction — streaming, model allowlist, metered quotas. The provider key stays server-side. |
| **Identity** | `me()` — id, email, name, avatar, resolved from org auth (never the client). |
| **Realtime** | Ephemeral broadcast + presence per canvas; durable state stays in KV. Revoking a share drops the socket instantly. |

The full, agent-optimized contract is served live at **`{base}/llms.txt`** — point an agent at it and it can write a working canvas. See also [`docs/sdk.md`](docs/sdk.md).

---

## Configuration

Everything is configured by environment variables, validated at boot — boot fails loudly with a precise message on an invalid combination. The full surface is in [`.env.example`](.env.example) ([`BUILD_BRIEF.md` §8.1](BUILD_BRIEF.md)). Four swappable drivers:

| Concern | Options | Env |
|---------|---------|-----|
| Database | SQLite · Postgres | `CANVAS_DROP_DB` |
| Storage | local disk · S3-compatible (AWS S3, MinIO, Cloudflare R2) | `CANVAS_DROP_STORAGE` |
| URL mode | path · subdomain | `CANVAS_DROP_URL_MODE` |
| Auth | `proxy` (recommended prod) · `oidc` · `dev` | `CANVAS_DROP_AUTH_MODE` |

Swapping any driver is a config change, never a code change. **The blessed production profile is subdomain mode + an identity-aware proxy** (e.g. Cloudflare Access) verifying a signed JWT, with Postgres and S3.

---

## Security model

canvas-drop runs inside a **trusted organization**: everyone reaching it has already passed org SSO, and an email-domain allowlist keeps outsiders out entirely. That posture deletes whole problem classes — anonymous abuse, spam, public bot threats. What remains is a short list of **hard invariants that must never break** ([`BUILD_BRIEF.md` §12.0](BUILD_BRIEF.md)):

1. **No impersonation** — identity always comes from the server-side auth context, never anything the client sends.
2. **No credential or canvas theft** — API keys and tokens are hashed at rest and shown once; canvas passwords are argon2id.
3. **No unauthorized access** — a canvas is reachable only by its owner, or by allowed org members if it's shared, unexpired, and any password is satisfied. Owner-only canvases **404** to everyone else.
4. **No cross-canvas reach in subdomain mode** — each canvas is its own browser origin and cannot read, write, or act on another's data.
5. **Lifecycle is honored instantly** — revoke, expiry, disable, delete, slug-regen, and key-regen take effect on the next request and drop live realtime sockets. No stale grants.

Beyond those invariants the platform stays deliberately simple and permissive — built for colleagues to collaborate, not to fight a hostile internet.

**URL-mode isolation is a real choice:**

- **Subdomain mode** (`{slug}.canvases.example.com`) — full browser-origin isolation; canvas→management and canvas→canvas attacks are blocked by browser design. *Recommended for any multi-user production deployment.*
- **Path mode** (`host/c/{slug}/`) — all canvases share one origin with each other and the dashboard. Perfect for localhost and trusted single-user/own-hosting. Multi-user path mode is allowed **only** with an explicit `CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE=true` opt-in and an admin-visible warning, because the cross-canvas isolation is genuinely weaker.

No secrets ever reach the browser. Every endpoint is Zod-validated; uploads are path-traversal/zip-slip checked and served as inert bytes. An audit log records auth, CRUD, deploys, key/slug regeneration, password attempts, share lifecycle changes, AI usage, and admin actions.

---

## Production deployment

Docker-first and vendor-neutral — **one application image** plus off-the-shelf dependencies, fronted by an identity-aware proxy that terminates TLS and authenticates every request. The recommended stack:

- **Subdomain mode** with wildcard DNS + wildcard cert.
- An **identity-aware proxy** (Cloudflare Access, Google IAP, oauth2-proxy, or nginx+OAuth) handing the app a verified identity JWT.
- **Postgres** and an **S3-compatible** bucket.
- Admins bootstrapped via `CANVAS_DROP_ADMIN_EMAILS`; org membership gated by `CANVAS_DROP_ALLOWED_EMAIL_DOMAINS`.

The admin panel covers the all-canvases list with usage, disable/takedown/restore, the AI model allowlist, and global quota defaults.

---

## Architecture

```
apps/server        Hono server — one role-routed process: API, deploy, hosted canvases
apps/dashboard     Vite + React SPA dashboard
packages/shared    zod config, dual-dialect Drizzle schema, shared types
packages/sdk       the zero-config browser SDK (the `canvasdrop` global)
docs/              BUILD_BRIEF, plans, compounding learnings, SDK + testing notes
```

**Dual-dialect is sacred.** SQLite and Postgres are kept in lockstep via shared column helpers; code targets shared inferred types, and the CI matrix runs the full suite on **both** dialects. **Config is the only `process.env` reader** — everything else takes typed config. Everything load-bearing sits behind an interface.

---

## Status

**v1 is feature-complete** and being hardened toward a public release. Built unit-by-unit from [`BUILD_BRIEF.md`](BUILD_BRIEF.md), every milestone on `main` with CI green on both dialects:

- ✅ **Foundation** — config, the four pluggable drivers, structured logging, audit log, auth gateway
- ✅ **Hosting + deploy** — folder/ZIP/paste/API deploy, versioning, rollback
- ✅ **Dashboard SPA** — create flow, canvas detail, versions, stats, settings, archiving + purge
- ✅ **Editor** — content-addressed storage, draft/publish model, in-browser file manager + CodeMirror
- ✅ **Primitives** — KV, files, `me()`, browser SDK with URL-mode auto-detection + `/llms.txt`
- ✅ **AI + realtime** — streaming Anthropic proxy with quotas; ephemeral pub/sub + presence
- ✅ **Gallery + admin hardening** — opt-in gallery, admin panel, rate limits, IAP-trust verification
- ✅ **Beyond v1** — clone-as-template, usage stats, server-side list filters, in-app docs (`/docs`, `/llms.txt`)

Remaining toward 1.0: ops/packaging — a Docker image + compose file (not in the repo yet), a backup/restore drill, and a single-VPS load test, then a colleague pilot behind an IAP. See [`docs/plans/`](docs/plans/).

---

## Commands

```bash
pnpm dev          # run server + dashboard in watch mode (Ctrl-C stops both)
pnpm test         # full suite — runs BOTH dialects (sqlite + pglite) in-process
pnpm test:sqlite  # sqlite leg only
pnpm test:pg      # postgres leg only
pnpm lint         # biome check
pnpm format       # biome check --write (also sorts imports)
pnpm typecheck    # tsc --noEmit across server, sdk, dashboard
pnpm build        # compile the server + SDK bundle
pnpm purge        # reclaim storage from soft-deleted canvases (see below)
```

Deleting a canvas is a **soft-delete** (the row is kept as a tombstone). `pnpm purge` is the maintenance sweep that reclaims the heavy data — each soft-deleted canvas's files and version rows are hard-deleted. It reads the same config as the server, so it acts on whichever DB + storage you're wired to.

```bash
pnpm purge            # reclaim every soft-deleted canvas
pnpm purge 30         # only those soft-deleted 30+ days ago
pnpm purge 30 dry-run # report what 30 days would reclaim, delete nothing
```

The first argument is the retention window in days (`0`/omitted = everything); `dry-run` previews without deleting. Reclaiming files is irreversible.

---

## Contributing

canvas-drop is built by humans and AI coding agents working from the same contract. Work flows from plans in [`docs/plans/`](docs/plans/) — one unit at a time, with its tests, CI green on both dialects before merge. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) (read by Claude Code and Codex alike); institutional learnings compound in [`docs/solutions/`](docs/solutions/).

## License

MIT — see [`LICENSE`](LICENSE).
</content>
</invoke>

# canvas-drop

A self-hostable platform where authenticated members of an organization deploy and share small web artifacts ("canvases") in seconds. Open-source (MIT), deployment-agnostic, no telemetry.

> **Status: hosting + deploy complete.** This repo is being built unit-by-unit from [`BUILD_BRIEF.md`](BUILD_BRIEF.md). The **foundation layer** — config, the four pluggable abstractions (database, storage, URL mode, auth), structured logging, the audit log, and the auth gateway — and **canvas hosting + the deploy pipeline** (areas C+D — create/serve/deploy a canvas via folder, ZIP, paste-HTML, or the Bearer-key API, with versioning + rollback) are done and on `main` (CI green on both dialects). Next: the dashboard SPA (area E), then the five primitives (KV, files, AI, identity, realtime) — see [`docs/plans/`](docs/plans/).

## Quickstart (local dev)

Requires **Node 24** and **pnpm**.

```bash
pnpm install
cp .env.example .env      # defaults: path mode + SQLite + local storage + dev auth
pnpm dev                  # starts BOTH apps in watch mode (Ctrl-C to stop)
```

`pnpm dev` runs the server and the dashboard together. Open:

- **http://localhost:5173** — the dashboard, with hot-reload (Vite HMR for the
  frontend; `tsx watch` restarts the server on backend changes). Use this while developing.
- **http://localhost:3000** — the Hono server: the API, the deploy endpoints, and
  hosted canvases. The dashboard at :5173 proxies `/api`, `/auth`, and `/v1` here.

Stop everything with a single **Ctrl-C** — both apps shut down cleanly. `dev` auth
auto-logs-in a fake local user, zero setup. Check the server is alive:

```bash
curl http://localhost:3000/healthz      # → {"status":"ok","db":"ok","version":"0.0.0"}
```

To log in as yourself in dev mode, set `CANVAS_DROP_DEV_USER_EMAIL` in `.env`.

> **Port already in use?** A `EADDRINUSE` on :3000 (or a strict-port error on
> :5173) means a previous dev server is still running. Find and stop it:
> ```bash
> lsof -nP -iTCP:3000 -sTCP:LISTEN     # note the PID, then: kill <PID>
> ```
> Or run on a different port: `CANVAS_DROP_PORT=3001 pnpm dev`.

## Configuration

Everything is configured by environment variables, validated at boot — see [`.env.example`](.env.example) for the full surface and [`BUILD_BRIEF.md` §8.1](BUILD_BRIEF.md). The four swappable drivers:

| Concern | Options | Env |
|---------|---------|-----|
| Database | SQLite · Postgres | `CANVAS_DROP_DB` |
| Storage | local disk · S3-compatible | `CANVAS_DROP_STORAGE` |
| URL mode | path · subdomain | `CANVAS_DROP_URL_MODE` |
| Auth | `proxy` (recommended prod) · `oidc` · `dev` | `CANVAS_DROP_AUTH_MODE` |

Swapping any driver is a config change, never a code change. The blessed production profile is subdomain mode + an identity-aware proxy (e.g. Cloudflare Access) verifying a signed JWT + Postgres + S3. Boot fails loudly with a precise message on invalid combinations.

## Commands

```bash
pnpm dev          # run server + dashboard in watch mode (Ctrl-C to stop)
pnpm test         # full test suite — runs BOTH dialects (sqlite + pglite)
pnpm test:sqlite  # sqlite leg
pnpm test:pg      # postgres leg
pnpm lint         # biome
pnpm typecheck    # tsc
pnpm build        # compile the server
```

## Layout

```
apps/server        Hono server (one role-routed process)
apps/dashboard     SPA dashboard (later plan)
packages/shared    zod config, dual-dialect Drizzle schema, shared types
packages/sdk       browser SDK (later plan)
docs/              plans, learnings, agent workflow, testing notes
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) (the shared contract for human and AI contributors). Work flows from plans in `docs/plans/`, one PR per unit, CI green on both dialects before merge.

## License

MIT — see [`LICENSE`](LICENSE).

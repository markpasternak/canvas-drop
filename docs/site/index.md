# canvas-drop

Deploy and share the small web tools your org builds, behind your sign-in.

canvas-drop is an open-source (MIT), self-hostable platform where signed-in
members of an organization publish and share small web artifacts called
**canvases**. A canvas is static files (HTML, CSS, JS, images). Drop them in and
they are live at a URL your colleagues can open once they sign in.

The constraint is the product: a small, fixed set of primitives done well, not a
general-purpose hosting platform. There is no server-side build step and no
secret in the page. A canvas gains backend capability only through five
primitives (KV, files, AI, identity, realtime) served by a zero-config browser
SDK, and that backend stays off until the owner turns it on.

## Try it

A logged-in local instance with no external services (`path` URLs, SQLite, local
files, `dev` auth):

```sh
git clone https://github.com/<your-fork>/canvas-drop.git
cd canvas-drop
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://localhost:5173`, click **Create canvas**, and paste an `index.html`.
It is live at `http://localhost:3000/c/{slug}/`. The [Quickstart](/docs/quickstart)
walks the rest of the loop: deploy, edit, share, roll back.

For the production shape instead, `docker compose up --build` boots Caddy, an
identity-aware proxy with a bundled demo IdP, Postgres, and the app at
`http://localhost:8080` (sign in as `demo@example.com` / `canvasdrop`). See
[Self-hosting → Install](/docs/self-hosting/install).

## What ships today

| Area | What you get | Read more |
|---|---|---|
| Publish | Paste a single `index.html`, drag a folder, upload a `.zip`, or `PUT` to the deploy API with a per-canvas key. A staged upload sends only the files that changed. | [Create & publish](/docs/authoring/create-and-publish), [Deploy API](/docs/api/deploy-api) |
| Edit in the browser | One mutable draft per canvas: file tree, code editor, live preview, and on-page text editing when the draft is a single HTML file. **Publish** snapshots the draft into a version. | [The editor](/docs/authoring/editor) |
| Versions | Every publish or deploy is an immutable version; the last 10 are kept. **Make current** rolls back or forward, any version downloads as a ZIP, and non-current versions can be deleted. | [Versions, rollback, and restore](/docs/authoring/editor#versions-rollback-and-restore) |
| Share | Five access rungs per canvas: Private, Specific people, Team, Whole org, Public link. Add a password or an expiry. Access is checked on every request, so a revoke takes effect on the next one. Public link is static-only. With an org boundary configured (`CANVAS_DROP_ORG_NAME`), Whole org scopes to the canvas's home org. | [Sharing & access](/docs/authoring/sharing) |
| Roles | Make a person or a team a **viewer** or an **editor**. Editors edit, publish, roll back, and change sharing; deleting, transferring, and the guest-AI switch stay with the owner. Two editors never overwrite each other silently, and ownership transfers to an editor in one step. | [Roles: viewers and editors](/docs/authoring/sharing#roles-viewers-and-editors) |
| Teams | Any signed-in user can create a personal team; org members can attach teams to their org. Add people by email, then grant the team viewer or editor access to a canvas. | [Teams](/docs/authoring/teams) |
| Backend | Turn on the backend per canvas, then toggle `kv`, `files`, `ai`, and `realtime` independently; `me()` is on whenever the backend is. A further opt-in, authoring, lets a page create canvases as the signed-in viewer. | [Capabilities](/docs/authoring/capabilities), [Browser SDK](/docs/sdk/overview) |
| Discover | **Shared** lists the canvases already opened to you. The **Gallery** is opt-in: Public-link canvases and Whole-org canvases their owners list. Listed canvases can be cloned as templates. | [Listing in the gallery](/docs/authoring/sharing#listing-in-the-gallery) |
| Agents | The MCP server at `{base}/mcp` (OAuth 2.1, 46 identity-scoped tools) covers everything the dashboard can do. `{base}/llms.txt` and the agent skill describe the whole surface for models. | [MCP server](/docs/agents/mcp), [llms.txt](/docs/agents/llms), [Agent skill](/docs/agents/skill) |
| Admin | Disable or restore any canvas, reassign owners, feature canvases in the gallery, block users, grant public-link publishing per account, and edit runtime settings (AI key and quotas, screenshots, design skin) without a restart. | [Configuration](/docs/self-hosting/configuration) |
| Operate | SQLite or Postgres, local disk or S3, path or subdomain URLs, `dev` / `proxy` / `oidc` auth: each is a config swap, never a code change. Docker image and compose stack; `pnpm backup`, `pnpm restore`, `pnpm purge`. | [Install](/docs/self-hosting/install), [Security model](/docs/self-hosting/security-model) |

## Trust posture

- Identity comes from the server-side auth context, never from the client. In
  `proxy` mode only the trusted proxy may assert it.
- Secrets stay server-side. Provider keys and deploy keys never reach the browser.
- Backend off by default; each primitive is a per-canvas opt-in.
- Canvases are private to your org unless an owner widens access, and Public
  link is gated by an instance switch plus a per-account grant.
- Your infrastructure, your data. No telemetry, no phone-home.

The [security model](/docs/self-hosting/security-model) states the threat model
(a trusted org, not the hostile internet) and the tradeoffs, including path
versus subdomain isolation.

## Status

v1 is feature-complete. Milestones M1 through M9 (foundation, hosting and
deploy, the dashboard, the editor and version model, the five primitives and
SDK, admin, gallery, AI and realtime) are shipped, along with the post-v1 work
in the table above: the access ladder, editor roles and ownership transfer,
teams, Shared discovery, the MCP server, staged uploads, custom slugs,
clone-as-template, usage stats, optional screenshots, design skins, and the
authoring capability.

Ops and packaging (M10) is the only open milestone. The Docker image and compose
stack, vendor-neutral deploy docs, backup/restore tooling, the security review,
and the starter examples have shipped. Still deferred: an executed backup/restore
drill against real data, a single-VPS load test, and a colleague pilot behind an
identity-aware proxy. canvas-drop has not yet run under a real org's load; treat
it as ready to self-host and evaluate, not as battle-tested.

Not in v1: a CLI (the deploy API, MCP server, and agent skill cover programmatic
deploys), custom domains, multi-org tenancy, KV change subscriptions, and
realtime message history.

## Where to go next

- New here? Start with the [Quickstart](/docs/quickstart).
- Building a canvas with a backend? Read the [SDK overview](/docs/sdk/overview).
- Sharing with colleagues or adding editors? See [Sharing & access](/docs/authoring/sharing).
- Running your own instance? See [Self-hosting → Install](/docs/self-hosting/install).
- An AI agent? Read [`/llms.txt`](/llms.txt), then connect over the [MCP server](/docs/agents/mcp).

> Examples and URLs in these docs use `{base}` (your instance's base URL) and
> `localhost` placeholders. Substitute your own instance's address.

# canvas-drop

Deploy and share the small web tools your org builds, behind your sign-in.

This page is for anyone deciding whether to run canvas-drop, or wondering what
it does today. By the end you know what a canvas is, what ships, what is still
open, and which page to read next for your job.

canvas-drop is an open-source (MIT), self-hostable platform where signed-in
members of an organization publish and share small web artifacts called
**canvases**. A canvas is static files (HTML, CSS, JS, images). Drop them in and
they are live at a URL your colleagues can open once they sign in. It is
inspired by Shopify's Quick; canvas-drop is the open way to run the idea on your
own infrastructure.

The constraint is the product: a small, fixed set of primitives done well, not a
general-purpose hosting platform. There is no server-side build step and no
secret in the page. A canvas gains backend capability only through five
primitives (KV, files, AI, identity, realtime) served by a zero-config browser
SDK, and that backend stays off until the owner or an editor turns it on.

## Try it

A signed-in local instance with no external services (`path` URLs, SQLite, local
disk, `dev` auth). You need Node 24 or newer and pnpm:

```sh
git clone https://github.com/markpasternak/canvas-drop.git
cd canvas-drop
pnpm install
cp .env.example .env
pnpm dev
# dashboard http://localhost:5173 · server http://localhost:3000
```

Open `http://localhost:5173`, click **Create canvas**, choose **Paste HTML**, and
paste an `index.html`. It is created and published in one step and live at
`http://localhost:3000/c/{slug}/`. To give it a backend, switch on **Enable
backend** in the canvas's **Backend** tab and add one tag to the page:

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const me = await canvasdrop.me();
  const views = await canvasdrop.kv.increment("views");
</script>
```

The [Quickstart](/docs/quickstart) walks the rest of the loop: deploy, edit,
share, roll back.

For the production shape instead, `docker compose up --build` boots Caddy, an
identity-aware proxy (oauth2-proxy) signing in against a bundled demo identity
provider (Dex), Postgres, and the app in real `proxy` auth mode at
`http://localhost:8080` (sign in as `demo@example.com` / `canvasdrop`). See
[Self-hosting → Install](/docs/self-hosting/install).

## What ships today

| Area | What you get | Read more |
|---|---|---|
| Publish | Paste a single `index.html`, drag files or a folder, upload a `.zip`, or `PUT` a ZIP to the Deploy API with a per-canvas `cd_...` key. A staged upload sends only the files the server does not already have. Limits: 100 MB per canvas, 25 MB per file, 2 000 files. | [Create & publish](/docs/authoring/create-and-publish), [Deploy API](/docs/api/deploy-api) |
| Edit in the browser | One mutable draft per canvas: file tree, code editor, autosave, inline preview, and on-page text editing when the draft is a single HTML file. **Publish** snapshots the draft into a version. | [The editor](/docs/authoring/editor) |
| Versions | Every publish or deploy is an immutable version; the last 10 are kept. **Make current** rolls back or forward, **Restore** copies a version into the draft, any version downloads as a ZIP, and non-current versions can be deleted. | [Versions](/docs/authoring/editor#versions) |
| Share | Name people and teams as viewers or editors — that list always applies — then pick General access: Restricted, Whole org, or Public link. Add a password or an expiry. Access is checked on every request and never cached, so a revoke takes effect on the next one. Public link is static-only: anonymous visitors get no primitives. With an org boundary configured (`CANVAS_DROP_ORG_NAME`), Whole org means the canvas's home org. | [Sharing & access](/docs/authoring/sharing) |
| Roles | Each person or team on the people list is a **viewer** or an **editor**. Editors edit, publish, roll back, change settings and sharing, and rotate the deploy key; deleting, transferring ownership, and the guest-AI switch stay with the owner (`OWNER_ONLY`). Only org members can be editors. A stale save is refused with `DRAFT_CONFLICT`, so two editors never overwrite each other silently. Ownership transfers to an editor in one step. | [Roles: viewers and editors](/docs/authoring/sharing#roles-viewers-and-editors) |
| Teams | Any signed-in user can create a personal team; org members can create org-attached teams. Add people by email, then grant the team viewer or editor access to a canvas. | [Teams](/docs/authoring/teams) |
| Backend | Turn on the backend per canvas, then toggle KV, files, AI, and realtime independently; identity (`canvasdrop.me()`) is on whenever the backend is. A call to a disabled primitive fails with `CAPABILITY_DISABLED`. A further opt-in, authoring, lets a page create canvases as the signed-in viewer. | [Capabilities](/docs/authoring/capabilities), [Browser SDK](/docs/sdk/overview) |
| Discover | **Shared** lists the canvases already opened to you. The **Gallery** is opt-in: Public-link canvases and Whole-org canvases their owners list, scoped to your org. An owner can also allow a listed canvas to be used as a template, which others clone. | [Gallery, description, and tags](/docs/authoring/sharing#gallery-description-and-tags) |
| Agents | The MCP server at `{base}/mcp` (OAuth 2.1, 46 identity-scoped tools) covers everything the dashboard can do, with the same owner/editor/viewer checks. `{base}/llms.txt` and the agent skill (`{base}/skill.zip`) describe the whole surface for models. | [MCP server](/docs/agents/mcp), [llms.txt](/docs/agents/llms), [Agent skill](/docs/agents/skill) |
| Admin | Disable or restore any canvas, reassign owners, feature canvases in the gallery, block users, grant public-link publishing per account, and edit runtime settings (AI key and quotas, screenshots, design skin) without a restart. | [Configuration](/docs/self-hosting/configuration) |
| Operate | SQLite or Postgres, local disk or S3-compatible storage, `path` or `subdomain` URLs, `dev` / `proxy` / `oidc` auth: each is a config swap, never a code change. Docker image and compose stack; `pnpm backup`, `pnpm restore`, `pnpm purge`. | [Install](/docs/self-hosting/install), [Deploy](/docs/self-hosting/deploy), [Security model](/docs/self-hosting/security-model) |

## Trust posture

- Identity comes from the server-side auth context, never from the client. In
  `proxy` mode only the trusted proxy may assert it.
- Secrets stay server-side. AI provider keys and deploy keys never reach the
  browser.
- The backend is off by default; each primitive is a per-canvas opt-in.
- Every canvas starts Private. Only its owner or an editor widens access, and
  Public link is gated by an instance switch plus a per-account grant on the
  owner.
- Your infrastructure, your data. No telemetry, no phone-home.

The [security model](/docs/self-hosting/security-model) states the threat model
(a trusted org, not the hostile internet) and the tradeoffs, including path
versus subdomain isolation.

## Status

v1 is feature-complete. Milestones M1 through M9 (foundation, hosting and
deploy, the dashboard, canvas management, the editor and version model, the five
primitives and SDK, admin and hardening, the gallery, AI and realtime) are
shipped, along with the post-v1 work in the table above: the access ladder,
editor roles and ownership transfer, teams and auth-delegated invites, Shared
discovery, the MCP server, staged uploads, custom slugs, clone-as-template,
usage stats, optional screenshots and preview covers, design skins, and the
authoring capability.

Ops and packaging (M10) is the only open milestone. The Docker image and compose
stack, vendor-neutral deploy docs, backup/restore tooling (with an automated
round-trip test on both dialects), the security review, a secret scan in CI, and
the starter examples have shipped. Still deferred: a single-VPS load test and a
colleague pilot behind an identity-aware proxy. canvas-drop has not yet run under
a real org's load; treat it as ready to self-host and evaluate, not as
battle-tested.

Not in v1: a CLI (the Deploy API, MCP server, and agent skill cover programmatic
deploys), custom domains, multi-org tenancy, an audit-log viewer in the admin
panel, KV change subscriptions, and realtime message history.

## Where to go next

- New here? Start with the [Quickstart](/docs/quickstart).
- Building a canvas with a backend? Read the [SDK overview](/docs/sdk/overview).
- Sharing with colleagues or adding editors? See [Sharing & access](/docs/authoring/sharing).
- Running your own instance? See [Self-hosting → Install](/docs/self-hosting/install),
  then [Configuration](/docs/self-hosting/configuration).
- An AI agent? Read [`/llms.txt`](/llms.txt), then connect over the [MCP server](/docs/agents/mcp).

> Examples and URLs in these docs use `{base}` (your instance's base URL) and
> `localhost` placeholders. Substitute your own instance's address.

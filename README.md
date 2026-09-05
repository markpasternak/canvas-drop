# canvas-drop

**From a working artifact to a tool your team uses.**

Publish web tools from your laptop, cloud workspace, or AI agent. Give them a stable address, control who can open or edit them, and keep improving them without sending another ZIP.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/markpasternak/canvas-drop/actions/workflows/ci.yml/badge.svg)](https://github.com/markpasternak/canvas-drop/actions/workflows/ci.yml)

[Explore the product](https://canvas-drop.com) · [Read the docs](https://canvas-drop.com/docs) · [Try it locally](#try-it-locally)

<p align="center">
  <img src="docs/site/assets/tour.webp" alt="Animated product tour: the canvas library, shared tools, editor, gallery, sharing, backend capabilities, usage, teams, and administration. Screens use example content." width="100%">
</p>

A useful tool should not depend on who has the latest ZIP, which chat created it, or who can open its cloud workspace. canvas-drop gives those artifacts a shared home: a live URL, named viewers and editors, and a version history you can recover from. Keep building in the tools you already use; publish here when someone else needs to use the result.

Self-hosted on your infrastructure. MIT licensed. No telemetry or phone-home.

## Why use it?

- **Share the result, wherever you built it.** Upload a folder or ZIP, paste HTML, or publish from an agent. Updates keep the same address, so colleagues can keep using their existing link.
- **Decide who gets access.** Start Restricted, add people or teams as viewers or editors, or share with your whole org. Admins can allow public links for static content. Named users sign in through your configured authentication.
- **Improve a tool while people use it.** Work in an autosaved draft, preview it, then review the changed files and audience before publishing. Recover an earlier version when you need to.
- **Turn something useful into a starting point.** Find tools shared with you, list selected canvases in your instance's gallery, and let colleagues clone templates. Hand over ownership when someone else takes a tool forward.
- **Add backend features as needed.** Save data, upload files, call AI, identify viewers, or add live collaboration through the browser SDK. Admin-approved Connections let a canvas call an external service while credentials stay on the server.

## Is it a fit?

canvas-drop works well when you have a browser-based tool that people need to use repeatedly: an interactive report from an AI conversation, a planning tool built in a cloud workspace, or a small internal app that needs a reliable home and controlled access.

A **canvas** is a set of HTML, CSS, JavaScript, and asset files. Plain HTML works; so does the output of a frontend build. Build in your existing tools, then publish the files. canvas-drop serves them as they are, with optional backend capabilities through its SDK.

For apps that need their own server code, build jobs, or database schema, use an application hosting platform. canvas-drop runs static files and a fixed set of backend capabilities. Public-link visitors receive static content only.

## Try it locally

You need **Node 24 or newer** and **pnpm 11**.

```bash
git clone https://github.com/markpasternak/canvas-drop.git
cd canvas-drop
pnpm install
cp .env.example .env
pnpm dev
```

Open **[localhost:5173](http://localhost:5173)**. You're signed in as a local development user, with sample canvases ready to explore. SQLite and local file storage are included; no accounts or external services are needed. Keep the terminal running while you use the app.

To publish your first canvas:

1. Select **Create canvas** and give it a title.
2. Choose **Paste HTML**, or upload a folder or ZIP containing `index.html` and its assets.
3. Check who can open it, then select **Create and publish**.
4. Open the published canvas. Its address stays the same when you upload another version or publish edits.

For a ready-made example, upload the files in [`examples/hello-static`](examples/hello-static). The [quickstart](https://canvas-drop.com/docs/quickstart) walks through editing, sharing, and version recovery. On your own local instance, the docs are also available at **[localhost:3000/docs](http://localhost:3000/docs)**.

<details>
<summary>Prefer to evaluate with Docker?</summary>

From a clone of this repository, with Docker and Docker Compose v2 installed:

```bash
docker compose up --build
```

Open **[localhost:8080](http://localhost:8080)** and sign in as `demo@example.com` with password `canvasdrop`. This includes Postgres, an identity-aware proxy, and a demo identity provider. The first build takes a few minutes.

The stack is for local evaluation: its credentials are public placeholders and it uses HTTP. Use the [deployment guide](https://canvas-drop.com/docs/self-hosting/deploy) for a real team.

Run `docker compose down` to stop the demo while keeping its data.

</details>

## Publish from your agent or workflow

Connect an MCP-compatible agent to **`https://your-instance/mcp`** and sign in with your normal account. The agent can create and publish canvases, edit drafts, manage sharing, inspect usage, and recover versions with the same role checks as the dashboard. See the [MCP setup guide](https://canvas-drop.com/docs/agents/mcp).

Your instance also provides an [installable agent skill](https://canvas-drop.com/docs/agents/skill) at `/skill.zip` and an agent-readable reference at `/llms.txt`.

For scripts and other publishing workflows, the Deploy API accepts a ZIP:

```bash
curl -X PUT "$BASE_URL/v1/canvases/$CANVAS_ID/deploy" \
  -H "Authorization: Bearer $CANVAS_KEY" \
  --data-binary @site.zip
```

Create the canvas first and copy its deploy key from the dashboard. Each key publishes only to its own canvas; keep it in your publishing environment, never in the canvas files. A successful API deploy goes live immediately. For repeat uploads, the [staged upload API](https://canvas-drop.com/docs/api/deploy-api) transfers only changed files.

## Give a canvas a backend

In the canvas's **Backend** tab, enable the capabilities it needs. Load the SDK from the canvas page:

```html
<script src="/sdk/v1.js"></script>
<script type="module">
  const viewer = await canvasdrop.me();
  const votes = await canvasdrop.kv.increment("votes", 1);
  document.body.textContent = `${viewer.name}: ${votes} votes so far`;
</script>
```

| Capability | Use it to |
|------------|-----------|
| **Key/value storage** | Save shared data or preferences specific to each viewer. |
| **Files** | Upload, list, and retrieve files belonging to a canvas. |
| **AI** | Stream model responses through the server, with model controls and usage quotas. |
| **Identity** | Learn who is using the tool from their signed-in session. |
| **Realtime** | Share live events and presence between viewers. |
| **Connections** | Call an exact HTTPS origin approved by an admin, with credentials held on the server. |

Backend access follows the canvas's permissions. AI requires a configured provider, and Connections require an admin grant. Optional [authoring](https://canvas-drop.com/docs/sdk/authoring) lets a canvas create other canvases as its signed-in user, when enabled by the instance and canvas settings.

Start with the [SDK guide](https://canvas-drop.com/docs/sdk/overview) or the working examples in [`examples/`](examples/).

## Run it for your team

You operate the instance and choose where its data lives. Use your existing identity provider through an identity-aware proxy or OIDC. Choose SQLite or Postgres for the database, and local disk or S3-compatible storage for files. There is no canvas-drop hosted account to create.

For a team deployment, use **subdomain mode with HTTPS** so every canvas has its own browser origin. Local path mode shares an origin and is intended for development or trusted single-user hosting. The [deployment guide](https://canvas-drop.com/docs/self-hosting/deploy) covers DNS, authentication, storage, and startup; [`.env.production.example`](.env.production.example) provides an annotated starting configuration.

Admins manage people, public-link availability, usage, quotas, AI providers, and appearance from the dashboard. Configured AI providers and outbound Connections can send data to the services you choose.

A canvas can contain up to **100 MB**, **2,000 files**, and **25 MB per file**. The last **10 published versions** are retained. Version recovery restores the published files; live backend data has its own lifecycle. Use the instance backup tools to protect the full database and stored files.

- [Configuration reference](https://canvas-drop.com/docs/self-hosting/configuration)
- [Sharing and access](https://canvas-drop.com/docs/authoring/sharing)
- [Security and isolation](https://canvas-drop.com/docs/self-hosting/security-model)
- [Backup, restore, and maintenance](docs/ops.md)

## Help and contribute

[Open an issue](https://github.com/markpasternak/canvas-drop/issues) for a bug, a feature request, or feedback from running your own instance. Include what you tried and what happened. Report security vulnerabilities through [SECURITY.md](SECURITY.md).

To work on the project, start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and the contribution workflow.

Inspired by Shopify's [Quick](https://shopify.engineering/quick), created by Daniel Beauchamp and Alex Pilon. Not affiliated with Shopify. Released under the [MIT license](LICENSE).

# Project status

Internal status ledger, moved from the README so its entry point stays focused on adoption. Verify current release work against merged pull requests and the relevant tracking issue.


**v1 is feature-complete**, built unit by unit from [`BUILD_BRIEF.md`](../BUILD_BRIEF.md) with CI green on both dialects at every merge. Milestones M1 through M9 are shipped: foundation, hosting and deploy, the dashboard, canvas management, the editor and draft/publish model, the original five primitives and the SDK, admin and hardening, the gallery, and AI and realtime.

Post-v1 work merged to `main`: the sharing ladder and **Shared** discovery, usage stats, server-side list filters and search, the docs system (`/docs`, `/llms.txt`, `/skill.zip`), clone-as-template, custom slugs, the MCP server (47 tools, dashboard parity), the staged content-addressed upload, the signed-out landing page, preview covers with an optional screenshot pipeline, admin-flippable [design skins](site/self-hosting/configuration.md#design-skins), the org boundary (tenancy) with teams and auth-delegated invites, the [authoring capability](site/sdk/authoring.md) and managed shares, prompt caching for the AI proxy, version download and delete, the org-scoped gallery, popularity sort and bulk actions, **editor roles with ownership transfer**, the simplified **Sharing and permissions** hierarchy with direct/team viewer clone parity, and admin-granted [outbound Connections](site/sdk/connections.md).

**M10 ops/packaging is the one open milestone.**

The [publishing and brand refresh](plans/2026-09-04-001-feat-publishing-experience-plan.md) and [library-to-publish UX round](plans/2026-09-05-001-feat-library-to-publish-ux-plan.md) add clearer library scanning, details for resuming work, audience summaries, publish review, version-recovery guidance, and keyboard/mobile polish. The marketing walkthrough, documentation screenshots, and animated tour above show the refreshed UI with example content.

| Shipped | Still deferred |
|---------|----------------|
| Docker image and compose stack | The single-VPS load test |
| Vendor-neutral deploy docs | A 10 to 15 person colleague pilot behind an IAP |
| Backup/restore tooling with a scheduled-maintenance runbook ([`docs/ops.md`](ops.md)) and an automated round-trip test on both dialects | |
| Security review of the five invariants ([`docs/security/`](security/)) | |
| Secret scan in CI | |
| This README, the quickstart, and three starter examples | |

> **Maturity, honestly:** canvas-drop boots, passes the dual-dialect suite, and self-hosts via Docker, but it has not been load-tested or run through a multi-user pilot yet; those are the open M10 items. Self-host reports, issues, and PRs are welcome.

Not started, and not claimed anywhere above: a CLI, DB-backed custom domains, multi-org tenancy, KV change subscriptions, and a structured-output AI helper. Plans and their status live in [`docs/plans/`](plans/).


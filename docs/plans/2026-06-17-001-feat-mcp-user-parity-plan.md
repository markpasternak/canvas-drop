---
title: "feat: MCP ↔ user parity — every dashboard action available as an MCP tool"
type: feat
status: completed
date: 2026-06-17
depth: deep
origin: agent-native principle (AGENTS.md)
covers: "Close the agent-native gap between the MCP tool surface and the owner/dashboard surface so anything a user can do in the UI, an agent can do over MCP."
---

# feat: MCP ↔ user parity

## Summary

The MCP tool surface is today a **subset** of what a canvas owner can do in the
dashboard. The deploy / version / verify core has good parity, but ~10 capability
areas around a canvas are MCP-missing: lifecycle (delete/archive/unarchive), metadata
(rename, description), slug change, deploy-key regeneration, sharing & access
(access rung, password, expiry), guest invites, gallery listing, backend capability
toggles, clone-as-template, usage stats, and the in-browser editor/draft loop.

This plan brings the MCP **fully on par**: every owner action that exists as a
management/draft route gets a corresponding MCP tool that **wraps the same service
layer** (no parallel logic), scoped by the same `requireOwned` owner check, audited
the same way. It also writes the parity rule into AGENTS.md so the bar is explicit and
self-enforcing for future work, and updates every agent-facing doc (the MCP reference,
the packaged skill, `/llms.txt`).

Success condition: **the MCP-vs-user delta table is empty** — every row in the
"user can, MCP cannot" list becomes a tool, with tests for the owner-scoping/no-leak
path and the happy path on both dialects.

## Principle (now in AGENTS.md)

> **Agent-native parity.** Anything a user can do in the dashboard UI, an agent must be
> able to do over the MCP. A new owner-facing capability is not done until its MCP tool
> exists. MCP tools wrap the same service layer the HTTP/management routes use — never a
> parallel implementation — and carry the same `requireOwned` owner check (a non-owned id
> reads as *not found*, §12.0) and the same audit events.

## Design

**One tool per UI action, consolidated where the UI consolidates.** The dashboard uses a
single `PATCH /:id/settings` for title/description/access/password/expiry/spaFallback/
gallery*/guest-AI, and a single `PATCH /:id/capabilities` for backend toggles — the MCP
mirrors that 1:1 with one `update_canvas` and one `set_capabilities` tool (optional
fields), rather than a tool per field. Lifecycle verbs and guest actions stay discrete
because the UI exposes them as discrete buttons.

New `McpToolDeps` wiring: the tool server currently has `canvases`, `versions`, `engine`,
`upload`, `storage`, `audit`, `hub`, `users`. Parity needs the same services the
management/draft routes already construct — thread them through `mcpRoutes` → `app.ts`:
`drafts` (DraftService), `cloneCanvas` (clone-service), `guests` (GuestService, optional —
oidc/dev only), `usage` (UsageEventsRepository), `aiUsage`/`files` repos for usage stats.

### Tool inventory (new)

| # | New MCP tool | Mirrors (route) | Service call |
|---|---|---|---|
| 1 | `update_canvas` | `PATCH /:id/settings` | `canvases.updateSettings` / `setPassword` (title, description, access, sharedExpiresAt, password set/clear, spaFallback, galleryListed, galleryTemplatable, gallerySummary, galleryTags, guestAiEnabled, guestAiCap) |
| 2 | `set_capabilities` | `PATCH /:id/capabilities` | `canvases.updateCapabilities` (backendEnabled, kv, files, ai, realtime) + hub revalidate on realtime/backend off |
| 3 | `set_canvas_slug` | `POST /:id/regenerate-slug` | slug validate + `canvases.updateSlug` (optional slug; empty → fresh random) |
| 4 | `regenerate_deploy_key` | `POST /:id/regenerate-key` | new key + `canvases.updateApiKeyHash` (returns the new `cd_…` once; refresh the `deploy` block curl) |
| 5 | `delete_canvas` | `DELETE /:id` | `canvases.softDelete` |
| 6 | `archive_canvas` | `POST /:id/archive` | `canvases.archive` |
| 7 | `unarchive_canvas` | `POST /:id/unarchive` | `canvases.unarchive` |
| 8 | `clone_canvas` | `POST /:id/clone` | `cloneCanvas` (template pick + blob copy); returns the new canvas + its one-time key + `deploy` block |
| 9 | `get_canvas_usage` | `GET /:id/usage` | `usage.countByType` / `viewStats` / `viewsByDay`, files + ai_usage |
| 10 | `list_access` | `GET /:id/allowlist` | `canvases.listAllowlist` (members + invited guests) |
| 11 | `grant_access` | `POST /:id/allowlist` | guest-invite flow (`canvases.addAllowlistEntry` + `guests.createInvite` + email); refused in proxy mode / when email unconfigured, same as the UI |
| 12 | `resend_guest_invite` | `POST /:id/allowlist/:entryId/resend` | re-mint + re-send |
| 13 | `revoke_access` | `DELETE /:id/allowlist/:entryId` | `canvases.removeAllowlistEntry` |
| 14 | `get_draft` | `GET /:id/draft` | `drafts.get` (state + file list; creates from live on first open) |
| 15 | `read_draft_file` | `GET /:id/draft/file` | draft file bytes (text utf8 / binary base64, same shape as `get_canvas_file`) |
| 16 | `write_draft_file` | `PUT /:id/draft/file` | `drafts.putFile` |
| 17 | `delete_draft_file` | `DELETE /:id/draft/file` | `drafts.deleteFile` |
| 18 | `rename_draft_file` | `POST /:id/draft/rename` | `drafts.rename` |
| 19 | `publish_draft` | `POST /:id/publish` | publish the draft as a new live version |
| 20 | `restore_draft` | `POST /:id/restore` | reset the draft to the live version |

Existing 12 tools stay. Net surface: 12 → 32.

## Implementation units (one branch, one PR — autonomous round)

- **U1 — deps wiring.** Thread `drafts`, `cloneCanvas`, `guests?`, `usage` (+ `files`,
  `aiUsage` as needed) into `McpToolDeps`, `mcpRoutes`, and the `app.ts` mount. No new
  tools yet; just the plumbing + types green.
- **U2 — lifecycle + metadata + slug + key.** Tools 1, 3–7. The `update_canvas` shared
  settings validation (reuse the management `settingsSchema` shape; the share/gallery
  preconditions — publish-before-share, no-password-before-gallery — must be enforced the
  same way, so factor the precondition check or call the same service path).
- **U3 — backend capabilities.** Tool 2.
- **U4 — sharing & guests.** Tools 10–13. `grant_access` (adds a member, or email-invites
  a guest) honors the proxy-mode / email-unconfigured refusals exactly like the UI; guest
  tools are absent (not erroring) when `guests` is unwired, mirroring the route.
- **U5 — clone + usage.** Tools 8, 9.
- **U6 — draft / editor loop.** Tools 14–20.
- **U7 — docs + AGENTS.md.** The parity principle in AGENTS.md (done up front in this
  round); rewrite the MCP reference tool table (`docs/site/agents/mcp.md`), the packaged
  skill (`skill/canvas-drop/SKILL.md`), and `/llms.txt` tool list to cover all 32 tools
  grouped by area; rebuild `pnpm docs:build`.

## Tests (per tool, both dialects)

For every mutating tool: (a) happy path changes state the way the route does; (b) the
**owner-scoping path** — a non-owner caller gets `canvas not found` with no existence
leak (extend the existing AE1 refusal loop to every new canvas-scoped tool); (c) the
key precondition failures the route enforces (e.g. share-before-publish, gallery-needs-
unprotected, invite-refused-in-proxy-mode). Reuse `apps/server/src/mcp/server.test.ts`
harness.

## Invariants / risk

- **Owner check on every tool** (`requireOwned`) — same no-leak contract as today (§12.0).
  Guest-invite and key-regeneration are the highest-risk; plan test-first per
  `docs/solutions/2026-06-13-auth-invariant-checklist.md`.
- **No parallel logic.** Each tool calls the same repo/service method the route calls. If a
  precondition lives in the route handler (not the service), factor it into a shared helper
  so the MCP path can't diverge from the UI path.
- **Dual-dialect** stays green; **`pnpm docs:build`** has no drift (CI asserts it).
- Run **`/ce-code-review`** before the PR (auth-shaped surface); fix all real findings.

## Out of scope

Admin-only actions (cross-owner list / disable / restore) — those are the dedicated admin
routes, not owner actions, and are intentionally not on the per-account MCP surface.

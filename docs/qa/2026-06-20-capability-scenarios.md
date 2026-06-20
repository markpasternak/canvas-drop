# Capability acceptance scenarios — canvas-drop

**Date:** 2026-06-20
**Author:** agent round (capability acceptance pass)
**Suite:** `apps/server/src/integration/capability-scenarios.test.ts` (harness: `scenario-harness.ts`)
**Status:** see _Evidence_ below.

---

## Purpose

Ten realistic, persona-driven journeys that together exercise **every major capability**
of the platform end-to-end through the *real* composed app (`buildApp` — the same role-routed
Hono app `index.ts` serves), not hand-rolled sub-apps. The suite is the acceptance net for
"does the whole product still work when a real user / agent uses it the way it's meant to be used."

This complements (does not replace) the unit/route tests: those assert one surface in
isolation; these assert the surfaces **composed** — gateway → identity → access → primitive →
audit, with the real wiring (AI provider, realtime hub, guest carve-out, MCP) all present.

---

## Evaluation method (defined before testing)

- **Unit of evaluation:** one scenario = one `it(...)`. A scenario **PASSES** iff *all* of its
  assertions pass; it **FAILS** on the first failed assertion. There is no partial credit and no
  manual scoring — the assertions *are* the pass/fail oracle (a binary check, run identically
  every time).
- **Same conditions for every scenario:** every scenario builds a fresh, migrated in-memory DB
  via `makeTestDb(dialect)` and the **same** `makeHarness(...)` wiring (identical config,
  fake-but-deterministic AI provider, in-process realtime hub, capturing mailer). No scenario
  depends on another's state.
- **Both dialects:** the suite is parametrized over `DIALECTS`. Under the standard runner
  `pnpm test` runs **both** sqlite and pglite in-process; `pnpm test:sqlite` / `pnpm test:pg`
  run a single leg. A scenario only counts as passing when it is green on **both** dialects.
- **Quality bar (the original bar, held constant across reruns):**
  1. All **10/10** scenarios pass on **both** dialects.
  2. The pre-existing suite stays green (no regressions introduced by the new code).
  3. `pnpm lint` and `pnpm typecheck` are clean.
- **Reruns:** on any failure, fix the **underlying cause** (product code or a genuinely wrong
  expectation — never a skip or a weakened assertion that hides a real defect), rerun the
  affected scenario, then rerun the **complete set** on both dialects. Repeat until the bar holds.
- **Evidence:** the recorded runner output (below) is the artifact for each outcome.

---

## The ten scenarios & their success criteria

Each scenario lists the **primary capabilities certified** and the **observable pass criteria**
(the assertions). "Member"/"owner"/"admin"/"guest" are distinct server-resolved identities
(via a header-driven auth strategy through the real gateway — identity is never client-trusted
in the assertion, only *which* org member is making the request, exactly as a proxy would assert).

### S1 — PM ships a pasted prototype (lifecycle + hosting)
Certifies: create (slug + once-shown key), paste-HTML publish, static serving (correct MIME,
`index.html` root fallback), version metadata, archive/unarchive, soft-delete.
Pass criteria:
- Create returns `201` with a readable slug and a `cd_`-prefixed key; only the **hash** is stored.
- Paste publishes a live v1; `GET /c/{slug}/` and `/c/{slug}/index.html` serve the bytes with
  `content-type: text/html`.
- A second asset (`style.css`) serves with a CSS content-type (MIME mapping).
- Version list reports the published version with `who/size/fileCount` metadata.
- Archive removes it from the active list and into `?scope=archived`; unarchive reverses it.
- Delete soft-deletes (excluded from the owner list); the live URL stops serving.

### S2 — Designer iterates in the editor (draft / publish version model)
Certifies: draft autosave (no version), explicit publish snapshot, live pointer swap, version
history, one-click rollback, restore-old-version-into-draft.
Pass criteria:
- Editing the draft creates **no** version; the draft preview shows the unpublished bytes.
- Publish creates v1 (live serves v1); edit + publish creates v2 (live serves v2); history = `[2,1]`.
- Rollback to v1 makes the live URL serve v1's bytes again and current points at v1.
- Restore v1 into the draft, then publish → v3 carries v1's content.

### S3 — Engineer ships via the deploy API + staged upload (agent contract)
Certifies: Bearer-key `deploy = live`, machine-readable result, read-back verify, rollback,
content-addressed **staged upload** (begin → PUT blobs → finalize), deploy-under-held-draft,
key isolation, validation (zip-slip, bad key).
Pass criteria:
- `PUT …/deploy` with the key returns `{ url, version:1, fileCount, warnings:[] }` and goes live.
- `GET …/files` reads back the live manifest + raw bytes with a matching content hash.
- A bad/absent key → `401`; a valid key for **another** canvas → `403`; a zip-slip ZIP → `400 ZIP_SLIP_REJECTED` with no ready version.
- Staged `begin` reports the missing hashes; each blob `PUT` → `204`; `finalize` publishes the version; the canvas reads back `published`.
- An agent deploy under an unpublished editor draft goes live **and** flags the draft `stale` (the draft bytes are preserved).

### S4 — Ops builds a form-backed tool (KV primitive)
Certifies: shared `kv` set/get/delete, `list` with prefix + pagination, atomic `increment`,
per-viewer `kv.user` isolation, capability management (toggle off → `403`, back on → works),
write metering.
Pass criteria:
- Shared set/get/delete round-trips; `list?prefix=&limit=` paginates with a `nextCursor`.
- `increment` returns a running total across calls.
- Two different members writing `kv.user` see **only their own** value (per-viewer scope, server-derived).
- `PATCH …/capabilities {kv:false}` → KV returns `403 CAPABILITY_DISABLED`; `{kv:true}` restores it.
- `kv_op` usage is metered (count > 0).

### S5 — File-intake tool (files primitive)
Certifies: multipart `upload`, `list` with metadata, authenticated download served as **inert**
bytes (`X-Content-Type-Options: nosniff`), `delete`, capability gating.
Pass criteria:
- Upload (`multipart/form-data`, field `file`) → `201 { id, name, size, url }`.
- List returns the file with its metadata.
- Download returns the exact bytes with `nosniff` set.
- Delete → `200`; the file then 404s; `file_op` metered.

### S6 — AI summarizer canvas (AI primitive)
Certifies: proxied `ai.chat` **SSE streaming**, model **allowlist** enforcement, **quota**
exceeded handling, per-call **metering**, no-secret-in-response.
Pass criteria:
- A streamed call emits `data:` `delta` frames whose text concatenates to the model output, then a
  `done` frame carrying `usage` + `cost`.
- A model **not** in the allowlist → `403 MODEL_NOT_ALLOWED` (no stream).
- With prior usage seeded past the canvas cap, the next call → `429 QUOTA_EXCEEDED`.
- After a successful call, the owner usage tab reports `aiTokens > 0` and `aiCalls > 0`.
- The provider API key never appears in any response body.

### S7 — Live poll / multiplayer (realtime primitive)
Certifies: per-canvas pub/sub broadcast, presence join + snapshot, cross-canvas isolation,
revoke-drops-socket, capability-off close code. (Runs against a real listening server + `ws`.)
Pass criteria:
- An authorized member's handshake upgrades (`101`); `subscribe` → `subscribed`; `publish` fans the
  event to subscribers; a second member sees a `join` and a `presence` snapshot listing both.
- A publish on canvas A never reaches a socket on canvas B.
- Lowering the canvas to `private` + `revalidateCanvas` closes the non-owner socket with `4401`.
- A realtime-capability-off canvas upgrades then closes `4403` with a `CAPABILITY_DISABLED` frame.

### S8 — Sharing ladder, guest invite & identity (access + identity primitive)
Certifies: the full access ladder, instant revoke, expiry, password gate, email-guest invite +
magic-link redeem, `me()` member vs guest, guest capability matrix, public-link admin gating.
Pass criteria:
- `private`: a non-owner member → `404` (no existence leak); the owner always reaches it.
- `whole_org`: any member reaches it; `me()` → `kind:"member"`.
- `specific_people` + invite a non-member email: the allowlist call reports `kind:"guest"` and an
  invite email is sent; redeeming the magic link sets a guest session; that guest's `me()` →
  `kind:"guest"`; the guest can use KV but AI returns `403 GUEST_AI_DISABLED`.
- Password gate: a member without the gate cookie → `401` gate page; the correct password → `303`
  + gate cookie; with the cookie the content serves `200`.
- Revoke: lowering `whole_org` → `private` makes the member `404` on the very next request.
- Expiry: a past `sharedExpiresAt` makes an allowed member `404` (re-checked per request).
- `public_link` without the admin grant → `403 PUBLIC_NOT_ALLOWED`.

### S9 — Admin governance & the hard invariants (admin panel + §12.0)
Certifies: all-canvases list + platform overview with usage, disable/takedown semantics,
enable/restore, model-allowlist + global quota management, and the admin-has-no-cross-owner-access
invariant (§12.0 #3), plus the public-publish grant.
Pass criteria:
- Admin overview + all-canvases list return totals and the seeded canvas with its usage/owner.
- Disable with a reason: the canvas URL serves its audience a **403 disabled page** (not the content);
  the **owner** sees the `disabledReason` via the management API; a non-owner → `404` on the owner
  management route; every owner mutation → `409 DISABLED`.
- Enable clears the takedown; restore reverses a soft-delete.
- `PUT /settings/models` sets the allowlist; `PUT /settings/quotas` sets a global default — both read back.
- An admin calling the **owner** management route for a canvas it does not own → `404` (no bypass).
- `grant-public` then lets that owner set `public_link` (the carve-out is admin-gated, not free).

### S10 — Agent over MCP at dashboard parity + clone/usage/docs (MCP control plane)
Certifies: the MCP tool surface drives the same service layer at owner parity, clone-as-template,
owner usage stats, gallery listing, and the public agent docs (`/llms.txt`).
Pass criteria:
- Over a real in-process MCP client: `whoami` → the account; `create_canvas` → id+once-shown key;
  `write_draft_file` + `publish_draft` → `get_canvas` reports `published`; `list_versions` shows v1;
  a second publish + `rollback_canvas` restores v1; `update_canvas {access}` shares it;
  `clone_canvas` yields a fresh unpublished draft owned by the caller; `get_canvas_usage` returns stats.
- An MCP tool called with **another owner's** canvas id → not-found (the `requireOwned` parity check).
- `GET /llms.txt` is public (`200`), is the agent reference, and documents the primitives.
- The shared+listed canvas appears in `GET /api/gallery`; a member can `clone` a templatable gallery canvas.

---

## Capability coverage matrix

| Major capability (BUILD_BRIEF area) | Scenario(s) |
|---|---|
| Canvas lifecycle (create/slug/version/archive/delete) | S1, S2 |
| Hosting/serving (MIME, index fallback, content) | S1 |
| Deploy pipeline (paste, Bearer API, staged upload) | S1, S3 |
| Editor draft/publish + rollback/restore | S2, S3 |
| KV primitive | S4 |
| Files primitive | S5 |
| AI primitive | S6 |
| Realtime primitive | S7 |
| Identity `me()` | S8 |
| Access ladder / sharing / password / expiry / revoke | S8 |
| Guest invites (carve-out) | S8 |
| Admin panel (list/takedown/restore/allowlist/quotas) | S9 |
| Security invariants (§12.0 #1/#3/#4/#5) | S3, S7, S8, S9 |
| MCP agent control plane (parity) | S10 |
| Clone-as-template | S10 |
| Usage stats | S6, S10 |
| Gallery | S10 |
| Docs / `llms.txt` (agent contract) | S10 |

---

## Evidence

All ten scenarios meet the bar on **both** dialects; the wider suite stays green; lint + typecheck clean.

| Check | Result |
|---|---|
| `capability-scenarios.test.ts` — sqlite leg | **10/10 pass** |
| `capability-scenarios.test.ts` — postgres (pglite) leg | **10/10 pass** |
| Both legs in one server run (`scripts/test-runner.mjs root`) | `capability-scenarios.test.ts (20 tests)` ✓ |
| Full server suite, both dialects | **1859 passed**, 0 failed (4 pre-existing env-gated skips) |
| Dashboard suite (`pnpm test` dashboard leg) | **547 passed**, 0 failed |
| `pnpm typecheck` | clean |
| `pnpm lint` (biome) | clean |

### Findings fixed during the loop (root-cause, not assertion-weakening)

Two scenarios failed on the first run; both were a **wrong expectation in the test**, corrected to the
product's actual (and correct) behavior — no product code changed, no assertion hidden:

1. **S3 (staged upload version number).** Expected the staged `finalize` to publish version `2`; it
   published `3`. Root cause: the rejected zip-slip deploy attempt earlier in the scenario consumes a
   version *number* (a `pending` row is allocated before path validation, then never becomes `ready`),
   so the next successful publish skips it. This is correct, documented engine behavior
   (`deploy-api.test.ts`: "no *ready* version"). Fix: assert the staged version is **newer than** the
   first deploy rather than a hard-coded number — the right invariant, robust to number-skipping.
2. **S9 (disabled-canvas serving status).** Expected a non-owner hitting a disabled canvas's URL to get
   `404`; it returns `403` (a takedown page). Root cause: `404` (don't-confirm-existence) is the posture
   for a **private** canvas; this canvas was `whole_org`, so its audience already knew it existed and a
   takedown shows them a `403` disabled page, not a deceptive `404`. The `404` invariant still holds on
   the **owner management route** for a non-owner (asserted separately, and it passed). Fix: assert the
   `403` takedown page on the content URL; the spec criterion above was corrected to match.

Both fixes were re-run on the affected scenarios, then the complete set was re-run on both dialects — all green.

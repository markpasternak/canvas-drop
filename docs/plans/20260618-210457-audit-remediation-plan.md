---
title: "fix: audit remediation — 20260618-210457 findings (120 fixes, 14 deferred)"
type: fix
status: planned
date: 2026-06-18
depth: deep
origin: docs/audits/20260618-210457/findings.json
covers: "Remediate the chosen audit findings from the 20260618 whole-app code-health audit, grouped by unit for parallel fixers. Honors per-finding fix notes (safe-half-only constraints). Leaves code review to the main loop."
---

# fix: audit remediation (20260618-210457)

## Summary

This plan drives the remediation of the **120 findings the owner chose to fix** from the
`20260618-210457` audit, grouped by **unit** so fixers can run in parallel (one unit per
worktree/branch). **14 findings are deferred** (recorded in the backlog section, no work planned).

Hard rules from `CLAUDE.md` apply to every fix:

- **Dual-dialect is sacred.** Any schema/type/test change must keep `schema.pg.ts` /
  `schema.sqlite.ts` in lockstep and pass on **both** legs (`pnpm test:sqlite` + `pnpm test:pg`).
- **Everything behind an interface.** No new `process.env` reads outside `config/env.ts`.
- **Auth is invariant-critical.** §12.0 hard-invariant fixes (fail-closed, owner checks,
  no-leak 404) are P0; weight hostile-internet findings to the trusted-org model.
- **No secrets in the browser. Agent-native parity** (MCP wraps the same service layer).

Run order within each unit: **P0 first, then P1, then P2.** Across units there are a few
cross-unit dependencies (noted inline) — most importantly the `packages` shared-type and
shared-constant extractions unblock `server-data` / `server-auth` / `server-http` cleanups,
so land `packages` early if you want the dependents to consume the shared symbols.

Every feature-bearing fix ships with the test named in its approach. Gate each unit with
`pnpm lint && pnpm typecheck && pnpm test` before opening the PR; CI is the authoritative gate.

---

## Gating / dependency notes

- **packages-8** (shared `CanvasAllowlistEntry` type) unblocks the server's local
  `AllowlistEntry` re-declaration cleanup (referenced by server-data). Land it before
  server-data if you want server-data to consume it; otherwise the server interface stays local.
- **server-auth-13 / server-http-17** both want the **same** shared KV-limits module.
  Coordinate: create `apps/server/src/canvas/kv-limits.ts` once (server-http-17 owns it) and
  have config-fields.ts import from it (server-auth-13). If running in parallel, server-http
  creates the module and server-auth rebases onto it.
- **server-platform-2** touches `config/env.ts` (loud-warning guard) and `email/log.ts`
  (redaction). **server-platform-11** also touches `email/factory.ts`. Same unit, sequence them.
- **server-http-5 / server-http-10** are the same defect (SDK self-Response missing
  security headers) + its docstring; fix the code, then the docstring claim becomes true.
- **server-data-2 / server-data-3** both edit `storage/local.ts`; do them together.

---

## P0 (do first, any unit)

| id | unit | one-line |
| --- | --- | --- |
| dashboard-1 | dashboard | fullscreen preview renders `{frame}` instead of `{body}`, bypassing scripted-draft notice |
| server-mcp-1 | server-mcp | deploy_canvas catch swallows non-DeployError; use failDeploy |
| server-platform-1 | server-platform | dropGatedNonOwners resolveCanvas unguarded — fail-closed violation |
| server-platform-2 | server-platform | log mailer leaks magic-link token + recipient (SAFE HALF) |

---

## Unit: dashboard

Paths: `apps/dashboard/src/components/`, `apps/dashboard/src/lib/`, `apps/dashboard/src/routes/`, `apps/dashboard/src/router.tsx`

### P0
- **dashboard-1** — Fullscreen bypasses scripted-draft notice. In `DraftPreview.tsx` line ~197 replace `{frame}` with `{body}` so the fullscreen branch shows the same scripts-notice/Run-preview body as inline. Verify: add a test that renders a scripted draft in fullscreen and asserts the notice text + Run-preview button are present (not the bare iframe).

### P1
- **dashboard-2** — `useRestoreToDraft` stale versions cache. In `lib/mutations.ts` add `qc.invalidateQueries({ queryKey: keys.versions(id) })` in `onSuccess`, mirroring `useUnpublishCanvas`. Test: after restore mutation, assert the versions query is invalidated.
- **dashboard-3** — Allowlist reload swallows errors to `[]`. In `canvas.share.tsx` `reload()`, replace `.catch(() => setEntries([]))` with a toast on failure (`err instanceof ApiError ? err.hint : "Couldn't load the access list"`) then `setEntries([])`. Test: mock a failing load, assert toast fires and empty state is distinguishable. (Full React-Query migration is dashboard-17, separate.)
- **dashboard-6** — SPA routes not announced + no `document.title`. In `router.tsx` (root layout) add a `useEffect` keyed on `useRouterState` pathname that sets `document.title` per route and focuses `#main-content` (already exists in app-layout.tsx). Test: simulate route change, assert title updated and focus moved.
- **dashboard-7** — Optimistic patch omits fields. In `useUpdateSettings.onMutate` add the same `if (patch.X !== undefined) optimistic.X = patch.X` lines for `access`, `guestAiEnabled`, `guestAiCap`, `galleryTemplatable`. Test: assert optimistic cache reflects each of the four fields immediately.
- **dashboard-9** — Fire-and-forget `.mutate()` no error feedback. Add `{ onError: (err) => toast(err instanceof ApiError ? err.hint : "Couldn't save", 'error') }` to the `.mutate()` call sites in `canvas.settings.tsx:79`, `canvas.share.tsx:70`, `canvas.capabilities.tsx:84` and `:106`. Test: mock mutation rejection at one call site, assert toast.
- **dashboard-4** — Toggle label not associated. In `Toggle.tsx` give the `<label>` and description `<p>` ids via `useId()` and set `aria-labelledby={labelId + ' ' + descId}` on the role=switch button. Test: assert the button has an accessible name equal to the label text.
- **dashboard-5** — HoldButton progress cue aria-hidden. In `HoldButton.tsx` remove `aria-hidden` from the holding cue and add `role='status'`; render it only while `holding`. Test: assert the cue is in the a11y tree while holding.
- **dashboard-12** — Toast role swaps dynamically. In `Toast.tsx` use two always-present static regions: `role='status' aria-live='polite'` for non-error and `role='alert' aria-live='assertive'` for error; route each toast by tone. Test: assert error toast lands in the alert region while a status toast is visible.
- **dashboard-8** — `normalizeDraftPath` untested. Add unit tests in `file-kind.test.tsx`: lowercasing/leading-slash strip, `..` segment → null, absolute path → null, backslash normalization, trailing-slash → null.
- **dashboard-10** — Stale router JSDoc. In `router.tsx` lines ~32-33 replace the "Filtering is client-side…" sentence with "Filtering, search, and sort are server-side: each param change fires a new /api/canvases request (plan 005)." (comment only.)
- **dashboard-11** — Gallery debounce duplication. In `gallery.tsx` replace the `[text,setText]` state + two effects with `const [text, setText] = useDebouncedUrlSearch(q, '/gallery')`. Verify existing gallery search tests still pass.

### P2
- **dashboard-19** — Fullscreen overlay no dialog semantics. In `DraftPreview.tsx` overlay add `role='dialog'`, `aria-modal='true'`, `aria-label='Full screen preview'`, `tabIndex={-1}`, focus-save/restore effect, and an Escape listener calling `onToggleFullscreen` (mirror `Dialog.tsx`). Test: Escape closes; focus trapped.
- **dashboard-20** — AccessLadder fieldset label. In `canvas.share.tsx` add `<legend className='sr-only'>Who can access this canvas</legend>` and drop the `aria-label`. Test: group has accessible name.
- **dashboard-21** — `useSlugAvailability` silent errors. In `use-slug-availability.ts` catch block add `console.warn('canvas-drop: slug availability check failed', err)` (minimum). Optionally an `'error'` status. Test: failing check logs and returns to a non-stuck state.
- **dashboard-23** — Dialog body-scroll lock race. In `Dialog.tsx` switch to a module-level ref-counted lock (increment on open, decrement on close, set/clear `overflow:hidden` on first/last). Test: open two dialogs overlapping exit transition, close both, assert body overflow restored.
- **dashboard-18** — `deployCurl` double-call + no tests. In `canvas.settings.tsx` compute `const curlSnippet = deployCurl(...)` once and reuse for CopyButton + `<pre>`. Add 3-4 unit tests (folder mode, zip mode, API key substitution, URL path).
- **dashboard-22** — Pagination label duplication. Extract `usePagination({ total, offset, items, pageSize })` returning `{from,to,hasPrev,hasNext,page}`; use in `index.tsx`, `gallery.tsx`, `admin.canvases.tsx`, `admin.users.tsx`. Test the hook's clamp.
- **dashboard-13** — `Canvas.status: string`. In `lib/api.ts` define `type CanvasStatus = 'active'|'archived'|'disabled'|'deleted'` and type `status` as it. Fix any resulting narrow-typing fallout. Typecheck is the gate.
- **dashboard-14** — `AdminConfigField` flat optional. Convert to discriminated union on `secret` (`{secret:false; value:string|undefined} | {secret:true; set:boolean; last4?:string}`). Update callers to narrow on `secret`. Typecheck gate.
- **dashboard-15** — `RootEntry` path/reason pairing. Model as discriminated union `{path:string;reason:'index'|'single'} | {path:null;reason:'ambiguous'|'none'}`. Update `canvas.overview.tsx` consumer. Typecheck gate.

> Deferred in this unit: **dashboard-16** (api.ts god-module split), **dashboard-17** (Allowlist React-Query migration).

---

## Unit: packages

Paths: `packages/sdk/src/index.ts`, `packages/sdk/src/index.test.ts`, `packages/shared/src/db/schema.pg.ts`, `packages/shared/src/db/schema.sqlite.ts`, `packages/shared/src/db/types.ts`, `packages/shared/src/config/env.ts`, `packages/shared/src/brand/brand.ts`, `packages/shared/package.json`

### P1 (correctness cluster in SDK error-mapping)
- **packages-1** — `channel.close()` orphans presenceWaiters. In SDK `close()`, grab the `ChannelState` before `channels.delete(name)`, reject all `presenceWaiters` with `new CanvasdropError('CHANNEL_CLOSED', 0, 'channel closed')`, clear the array. Test: in-flight `presence()` rejects on `close()`.
- **packages-6** — `publish()` after `close()` strands frame. Add a per-channel `closed` boolean in the closure; set in `close()`, throw `CanvasdropError('CHANNEL_CLOSED', 0, …)` in `publish()` when closed. Test: `publish()` after `close()` throws.
- **packages-2** — QuotaExceededError status + GUEST_AI_CAP. Change the `QuotaExceededError` default status to **429**. In `aiErrorFromFrame`, add `if (code === 'GUEST_AI_CAP') return new QuotaExceededError(code, 429);` before the QUOTA_EXCEEDED branch (or look up `ERROR_CODES[code]?.status ?? 429`). Tests: in-stream QUOTA_EXCEEDED and GUEST_AI_CAP frames yield `instanceof QuotaExceededError` with `.status===429`.
- **packages-7** — NOT_NUMERIC misclassified as Quota. In `errorFromResponse`, for 409 branch only map `KEY_LIMIT` → `QuotaExceededError`; let `NOT_NUMERIC` fall through to generic `CanvasdropError` (so `err.code==='NOT_NUMERIC'` works). Test: 409 NOT_NUMERIC is not `instanceof QuotaExceededError`.
- **packages-4** — readSSE raw SyntaxError. Wrap the `JSON.parse` in `readSSE` in try/catch, throw `CanvasdropError('MALFORMED_FRAME', 502, 'malformed SSE data line')`. Test: SSE body with a non-JSON data line yields a `CanvasdropError`.
- **packages-5** — reader lock leak. Wrap the `readSSE` reader loop in `try { … } finally { reader.releaseLock(); }`. Test: early `break` out of `for await` releases the lock (assert a second `getReader()` succeeds).
- **packages-3** — canvas_allowlist XOR CHECK. Add member/guest CHECK constraints in **both** schema files: `check('canvas_allowlist_member_chk', sql\`${t.principalKind} != 'member' OR ${t.userId} IS NOT NULL\`)` and the guest analog on `email`. Extend `schema.test.ts` to assert both constraint names exist on both dialects. Dual-dialect gate.
- **packages-8** — missing `CanvasAllowlistEntry` shared type. In `types.ts` import `canvasAllowlist` and export `CanvasAllowlistEntry`/`NewCanvasAllowlistEntry` via `$inferSelect`/`$inferInsert`. (Server can later alias it — see server-data.) Typecheck gate.

### P2
- **packages-16** — spurious `@opentelemetry/api` dep. Remove from `packages/shared/package.json` dependencies; `pnpm install`; confirm `pnpm -r build` + typecheck stay green (no import exists).
- **packages-11** — missing union types. Export `McpTokenKind`, `GuestInviteState`, `VersionSource`, `VersionStatus`, `UsageEventType` from `types.ts` and thread via `.$type<…>()` on the constrained columns in both schema files (keep lockstep). Dual-dialect gate.
- **packages-15** — SDK test gaps. Add tests for `kv.list` (with all options → full query string; with no options → plain URL), `kv.delete` (DELETE + URL), `files.list` (GET /files + parse), `files.delete` (DELETE /files/{id}).
- **packages-9** — stale usage_events comment. In both schema files update the comment to "Current types: kv_op | file_op | view | deploy | rt_connect" (drop "future:"). Comment only.
- **packages-12** — SDK module JSDoc omits ai/realtime. Expand the module comment to enumerate `canvasdrop.kv, canvasdrop.files, canvasdrop.ai, canvasdrop.realtime, canvasdrop.me()`. Comment only.
- **packages-13** — `brand.ts` references non-existent REBRAND.md. Remove the "see REBRAND.md" clause; fold guidance inline (edit brand.ts for name/domain/fonts, tokens.ts for colors/logo). Comment only.
- **packages-14** — rate-limit comment overstates admin-tunability. In `config/env.ts` lines ~155-156 rewrite to "read at boot from env only (not yet runtime-editable via the admin UI — deliberate follow-up)." Comment only.

> Deferred: **packages-10** (galleryTemplatable→galleryListed DB CHECK — behavior-changing).

---

## Unit: server-auth

Paths: `apps/server/src/auth/`, `apps/server/src/admin/config-fields.ts`, `apps/server/src/admin/settings-service.ts`

### P1
- **server-auth-1** — Guest session minted before status check (invite burned). In `guest-routes.ts` POST `/guest/:token`, peek the invite (read-only `guests.findInviteByTokenHash`), extract `canvasId`, read `canvases.findById` and return `invalidLink` 410 **before** `consumeMagicLink` if `canvas.status !== 'active'`. Test: archived canvas + valid token → 410 **and** the invite remains pending (re-clickable).
- **server-auth-2** — guest_login audit missing IP. In `guest-routes.ts` recordAudit call add `ip: c.get('clientIp') ?? undefined` (and `actorId: principal.id`). Test: guest_login audit row carries the IP.
- **server-auth-4** — IPv6 CIDR silently drops peers. Add startup config validation rejecting `CANVAS_DROP_TRUSTED_PROXY_IPS` entries that contain `:` in CIDR notation with a descriptive boot error (IPv4-only). Test: config with an IPv6 CIDR fails to load with a clear message.
- **server-auth-7** — `isEmailAllowed` DB error swallowed silently. In `identity-mapping.ts` catch, log before fail-closed: `log.error({ err, emailDomain: email.split('@')[1] }, 'allowlist DB lookup failed; denying')` (thread a logger param). Keep return-false. Test: injected DB error logs + denies.
- **server-auth-3** — Email logged in OIDC unverified path. In `oidc.ts` line ~194 replace `{ email: identity.email }` with `{ emailDomain: identity.email.split('@')[1], emailVerified: false }`. Test: assert no full email in the log payload.
- **server-auth-5** — OIDC completeLogin blocked path untested. Add a test in oidc.test.ts: seed user, `setBlocked`, call complete/`completeLogin`, assert 403 `{error:'forbidden'}`.
- **server-auth-6** — gateway/session/oidc tests sqlite-only. Wrap each `makeTestDb('sqlite')` describe in `gateway.test.ts`, `session.test.ts`, `oidc.test.ts` with `describe.each(DIALECTS)('… [%s]', (dialect) => { … makeTestDb(dialect) … })`, mirroring guest.test.ts. Dual-dialect gate.

### P2
- **server-auth-9** — OIDC error paths return raw JSON mid-flow. Route `no_email_claim`, `email_not_verified`, `email_domain_not_allowed` (and optionally forbidden) through `recoverableAuthError` with HTML + retry; add a `log.warn` for `no_email_claim`. Test: those paths render the recoverable HTML, not raw JSON.
- **server-auth-8** — `claimsToIdentity` untested. Add a `describe('claimsToIdentity')` block: namespaced sub for well-formed claims; empty/absent sub falls back to email; absent email → null; optional name/avatar omitted when missing.
- **server-auth-11** — `makeOidcConfigLoader` retry untested. Two-step test: first discovery rejects (assert rejects), then swap to succeeding mock (assert succeeds) — proves failure does not poison the cache.
- **server-auth-12** — ConfigField runtime-only invariants. Convert `ConfigField` to a discriminated union on `editable` (`{editable:true; settingKey:string} | {editable:false; settingKey?:never}`) and `ConfigFieldView` to a union on `secret`. Update callers; typecheck gate.
- **server-auth-13** — Inverted cross-layer import. Have `config-fields.ts` import KV constants from the new shared `apps/server/src/canvas/kv-limits.ts` (created in server-http-17) instead of `routes/canvas-kv.ts`. Coordinate with server-http-17. Typecheck gate.
- **server-auth-15** — Stale settings-service.ts comment. Update lines ~266-268 to "boolean: used by screenshots.enabled; enum: not yet editable (flip settingKey when needed)." Comment only.

> Deferred: **server-auth-10** (audit/session PII retention), **server-auth-14** (drop UA column — loses forensic signal).

---

## Unit: server-canvas

Paths: `apps/server/src/upload/service.ts`, `apps/server/src/draft/service.ts`, `apps/server/src/draft/draft-api.ts`, `apps/server/src/screenshots/`, `apps/server/src/canvas/`, `apps/server/src/deploy/engine.ts`

### P1
- **server-canvas-1** — Upload finalize double-publish on retry. In `upload/service.ts` `finalize()` swap commit order: call `markConsumed` **before** `commitReadyVersion` (a failed commit after consume forces a fresh `begin()`, which is acceptable). Test: simulate failure between steps; assert no second version row is created on retry.
- **server-canvas-2** — `pruneAndCollect` omits uploadSessions from GC live set. Add an optional `uploadSessions` to `DraftServiceDeps` and thread it into `collectGarbage` in `pruneAndCollect()`, mirroring `DeployEngineDeps/prune()`. Test: a publish during an in-flight staged session does not sweep that session's blobs.
- **server-canvas-3** — rename/delete `from`/`path` not normalized. At the top of `deleteFile` and `renameFile` in `draft/service.ts`, run `normalizeEntryPath(from/path)` and use the normalized key for manifest lookup, throwing INVALID_PATH only if normalization returns null (mirror writeFile). Test: `./index.html` as `from`/`path` resolves to the real file.
- **server-canvas-7** — restore() wrong error code/status for missing version. In `draft/service.ts` `restore()` throw `DeployError('VERSION_UNAVAILABLE', 'no ready version N')` and map `VERSION_UNAVAILABLE` → 404 in the `deployErr` handler in `draft-api.ts`, matching the rollback route. Test: restoring a pruned version → 404.
- **server-canvas-5** — SVG cross-canvas XSS in path mode. In `canvas/serve.ts` add `Content-Disposition: attachment` for `image/svg+xml` responses **when `config.urlMode === 'path'`** (mode-gated). Test: in path mode an SVG asset is served with the attachment header; in subdomain mode it is not.
- **server-canvas-8** — og rendition `Cache-Control: public` regardless of access. In `screenshots/serve.ts` `cacheControl()` / servePreview, use `private` unless `canvas.access === 'public_link'`. Test: whole_org/private canvas og rendition returns a private cache directive.
- **server-canvas-6** — resolvePreviewIds + files-service.delete swallow errors. Add optional `log?: Logger` to `PreviewHintDeps` and `FilesService` deps; log at warn inside the resolvePreviewIds catch and the `storage.delete(...).catch(...)`. Keep degraded behavior. Test: injected failure logs.
- **server-canvas-4** — `resolveSettingsUpdate` untested. Add `apps/server/src/canvas/settings-update.test.ts` covering all denial paths (SHARE_REQUIRES_PUBLISH, PUBLIC_NOT_ALLOWED, NOT_SHARED, NOT_PUBLISHED, PASSWORD_PROTECTED, NOT_LISTED) plus happy paths (password clears gallery metadata; private clears listed/templatable; deprecated `shared` alias). Pure-function tests.

### P2
- **server-canvas-10** — Duplicate version-retry + KEEP_VERSIONS cross-layer import. Move `KEEP_VERSIONS` to a neutral `deploy/constants.ts` (or shared errors), and extract the collision-retrying version-number insert into a shared helper consumed by both `deploy/engine.ts` and `draft/service.ts`. Typecheck + existing deploy/draft tests gate.
- **server-canvas-17** — clone-service + verifyPassword silent. Add `log?: Logger` to `CloneServiceDeps`; log at warn in each rollback `.catch()`. In `verifyPassword`, log unexpected argon2 errors at warn before returning false (distinguish from wrong password). Test: injected rollback/argon2 failure logs.
- **server-canvas-12** — Dead `log` dep + silent clearFinalizing. In `upload/service.ts` wire `deps.log?.warn(...)` into the `clearFinalizing(...).catch()` (use the already-declared field). Test: clearFinalizing failure logs.
- **server-canvas-11** — API key scan absent from staged/draft paths. Apply `looksLikeApiKey` (warn-only) in `stageOne` for text-mime blobs and in `draftService.writeFile`; replace `mime.contentType.startsWith('text/')` with `isTextContentType(mime.contentType)` in engine.ts line ~127. Test: a key-shaped string in an editor/staged text file emits the warning.
- **server-canvas-13** — Stale capability-guard.ts docstring. Rewrite to describe the live guard (KV/Files/AI/Realtime/identity routes run requireCapability after canvasAccess). Comment only.
- **server-canvas-14** — Inaccurate resolveAccessContext docstring. Update to note both `public_link` (owner-publish-enabled lookup) and `specific_people` (allowlist) do DB lookups. Comment only.

> Deferred: **server-canvas-9** (retry narrowing — behavior-changing), **server-canvas-16** (drop exists() in deploy hot path — behavior-changing), **server-canvas-15** (guest email audit PII retention).

---

## Unit: server-data

Paths: `apps/server/src/db/repositories/`, `apps/server/src/storage/local.ts`, `apps/server/src/storage/driver.ts`, `apps/server/src/canvas/purge.ts`, `apps/server/src/canvas/files-service.ts`

### P1
- **server-data-1** — settings.set() / oauth.clients.upsert() read-then-write race. Replace both with single-statement atomic upserts using `onConflictDoUpdate` (target `settings.key`; target `clients.id` set `clientInfo`), matching the kv/sessions pattern. Tests: concurrent writes do not throw a unique-constraint 500; dual-dialect.
- **server-data-5** — revertPublicForOwner leaves stale gallery flags. In `canvases.ts` replace `set({ access:'private', updatedAt })` with `set({ ...CLEARED_PUBLICATION_FIELDS, updatedAt })`. Test: after revert, `galleryListed`/`galleryTemplatable`/`sharedExpiresAt`/`galleryPublishedAt` are cleared and ownerSummary listed count is 0.
- **server-data-2** — LocalDriver.walk() swallows readdir errors (SAFE-NOTE). Use the **typed-rethrow** variant: on non-ENOENT, throw `StorageError('readdir failed', 'list_failed')`; keep `list()` **best-effort with logging** (do NOT make list() hard-fail). Test: EACCES surfaces as a typed error / logged, ENOENT still yields empty.
- **server-data-3** — LocalDriver.exists() returns false for all errors. In the catch, `if (isNotFound(err)) return false; throw err;` (align with get()/copy()). Test: non-ENOENT error rethrows; ENOENT → false.
- **server-data-6** — viewsByDay O(N) transfer. Replace the full-row fetch with a DB-side `GROUP BY (created_at / 86400000) * 86400000` returning ≤30 rows; keep the JS zero-fill. Works on both dialects (integer arithmetic, no date fns). Test: bucketed counts match prior output on both dialects.
- **server-data-4** — PII tables accumulate (retention prune). Add prune methods: `sessions.pruneExpiredBefore(cutoff)`, `audit.pruneBefore(cutoff)`, `oauth.codes.pruneConsumedOrExpiredBefore(cutoff)`, `oauth.tokens.pruneRevokedOrExpiredBefore(cutoff)`, `guest.pruneRevokedOrConsumedBefore(cutoff)`; wire into the existing retention sweep with a configurable window (`CANVAS_DROP_AUDIT_RETENTION_DAYS` via config/env.ts). Tests: each prune deletes only rows past the cutoff; dual-dialect.

### P2
- **server-data-10** — files-service.delete swallows blob-delete failure. Replace `.catch(() => {})` with `.catch((err) => log.warn({ err, canvasId, storageKey }, 'blob delete failed after row removal — orphaned blob'))` (add `log` dep). Test: storage failure logs.
- **server-data-7** — purge.ts sequential I/O. Replace the four sequential awaits in the per-canvas loop with one `Promise.all([...])` (versions.listByCanvas, drafts.getByCanvas, storage.list(blobPrefix), storage.list(screenshotPrefix)). Existing purge tests gate.
- **server-data-9** — guest/audit repos untested. Add `guest.test.ts` (createInvite idempotency, markConsumed single-use CAS, revokeInvite, revokeAllForCanvas, findLiveSessionByTokenHash excluding revoked/expired) and `audit.test.ts` (append fields, recent newest-first + limit) — both dual-dialect. Add an explicit `Promise<AuditRow[]>` return type to `recent()`.
- **server-data-13** — StorageError.code untyped string. Add `export type StorageErrorCode = 'not_found'|'delete_failed'|'invalid_key'` and type the constructor param. Existing throw sites unchanged. Typecheck gate.
- **server-data-8** — Misplaced pruneBeyond JSDoc. Move the pruneBeyond JSDoc directly above `pruneBeyond` (and deleteByCanvas's above deleteByCanvas); clarify the snapshot/atomicity wording. Comment only.

> Deferred: **server-data-12** (canvases.ts god-module split), **server-data-11** (session-touch/lastSeenAt gating — behavior-changing).

---

## Unit: server-http

Paths: `apps/server/src/routes/`, `apps/server/src/http/security-headers.ts`, `apps/server/src/canvas/kv-limits.ts` (new)

### P1
- **server-http-1** — Bearer deploy/rollback skip status guard. In `deploy-api.ts` PUT `/:id/deploy` and POST `/:id/rollback`, after `authCanvas()` add `if (auth.status !== 'active') return c.json({ code:'NOT_ACTIVE', message:'Unarchive this canvas before deploying.' }, 409)`; apply the same in the staged-upload `finalize()` path. Test: archived canvas → 409 on both routes.
- **server-http-3** — KV increment accepts NaN/Infinity. In `canvas-kv.ts` change the guard to `typeof body.by === 'number' && Number.isFinite(body.by)`, and return 400 when a non-finite value is explicitly supplied. Test: `by: Infinity` / `by: NaN` → 400, no counter corruption (both dialects).
- **server-http-6** — galleryTags unbounded. In `management.ts` settingsSchema change to `z.array(z.string().max(50)).max(20).optional()`. Test: oversized tags array/length rejected.
- **server-http-2** — Files upload + draft write buffer before size enforcement. Add `blobBodyLimit` middleware before the body read in `canvas-files.ts` POST `/` and `draft-api.ts` PUT `/:id/draft/file` (import from deploy-common). Test: oversized body rejected before allocation (413/limit error).
- **server-http-5** — SDK response bypasses security headers. In `serve-sdk.ts` build a `new Headers()`, call `baseSecurityHeaders(headers)`, then set content-type/cache-control before constructing the Response; do the same for `deploy-api.ts` GET `/:id/files`. Test: serve-sdk response includes `x-content-type-options: nosniff`. (Pairs with server-http-10.)
- **server-http-7** — AI body-size cap (SAFE HALF). Add **only** the AI body-size limit middleware to the AI chat route (e.g. 256 KB). Do **NOT** add `messages<=50` or content/system max-length caps (would cut off real conversations). Test: oversized AI body rejected; a normal large-but-valid conversation still passes.
- **server-http-4** — /api/me spread-leak test stale count. In `management.test.ts` add `canPublishPublic: true` to the stub (~line 1303), add `'canPublishPublic'` to the expected keys, and assert `body.canPublishPublic === true`. Turns the false-green into a real 9-field contract test.
- **server-http-8** — Admin cross-site rejection coverage. Add a parameterized test iterating every admin mutation route (method+path) asserting 403 on `Sec-Fetch-Site: cross-site`.

### P2
- **server-http-17** — KV limit constants exported from a route file. Create `apps/server/src/canvas/kv-limits.ts` with `KV_MAX_VALUE_BYTES`, `KV_MAX_KEY_BYTES`, `KV_MAX_KEYS_SHARED`, `KV_MAX_KEYS_USER`; have `canvas-kv.ts` and `admin/config-fields.ts` import from it (this is the shared module server-auth-13 consumes). Typecheck gate.
- **server-http-11** — Hub/guest revocation failures silent. Replace the empty `.catch(() => {})` blocks in `management.ts` with `.catch((err) => c.get('log')?.warn({ err, canvasId: cv.id }, '…'))` (guest revocation at error level). Test: injected failure logs.
- **server-http-12** — Draft preview catch-all silent. In `draft-api.ts` servePreview catch, `c.get('log')?.error({ err }, 'draft preview: unexpected error, returning not_found')` before `previewNotFound(c)`. Test: injected error logs while still returning not-found.
- **server-http-13** — Rollback body unsafe cast. Replace the cast with `z.object({ version: z.number().int().positive() }).safeParse(...)` in `management.ts` and `deploy-api.ts`; return `{ error:'invalid_body' }` on failure. Test: `version:1.5` / `-1` → 400 invalid_body.
- **server-http-16** — `publicCanvas` misnamed export. Rename to `ownerCanvasView` (single-file change in management.ts), drop the "misnamed" warning, remove the export if no external caller. Typecheck gate.
- **server-http-10** — securityHeaders docstring false claim. After server-http-5 fixes the handlers, update the docstring to be accurate (or list any remaining exceptions). Comment only — sequence after server-http-5.
- **server-http-9** — Stale managementRoutes JSDoc. Remove "Deploy routes added by U19"; describe what's actually mounted. Comment only.

> Deferred: **server-http-14** (KV quota TOCTOU enforcement — behavior-changing), **server-http-15** (remove email from admin views — admins trusted, PII).

---

## Unit: server-mcp

Paths: `apps/server/src/mcp/server.ts`, `apps/server/src/mcp/routes.ts`, `apps/server/src/mcp/provider.ts`, `apps/server/src/mcp/tool-kit.ts`, `apps/server/src/mcp/draft-tools.ts`, `apps/server/src/mcp/server.test.ts`

### P0
- **server-mcp-1** — deploy_canvas swallows non-DeployError. Replace the inline catch with `return failDeploy(e)` (matching begin_deploy/add_files/finalize_deploy); remove the two unsafe casts. Test: a non-DeployError thrown by `engine.deploy` propagates (not converted to a vague tool fail).

### P1
- **server-mcp-2** — rollback/deploy/begin_deploy missing NOT_ACTIVE guard. Add `if (cv.status !== 'active') return fail('NOT_ACTIVE: unarchive this canvas before deploying or changing its live version')` after the requireOwned null guard in `deploy_canvas`, `begin_deploy`, `rollback_canvas` (mirror publish_draft + HTTP routes). Test: archived canvas → NOT_ACTIVE for each tool.
- **server-mcp-6** — /mcp endpoint no body-size limit. Add a Hono `bodyLimit` middleware on the `/mcp` route, mounted before the bearer-auth check, sized to the canvas cap (~110 MB). Test: oversized JSON-RPC body rejected before buffering.
- **server-mcp-5** — set_canvas_preview no byte-size cap. Add `.max(40*1024*1024)` to the Zod image string and a post-decode `if (bytes.byteLength > LIMITS.maxFileBytes) return fail('IMAGE_TOO_LARGE: …')`. Test: oversized image rejected before sharp.
- **server-mcp-8** — issueTokens non-atomic. Wrap both token inserts in a single DB transaction (or at minimum `Promise.all`); prefer the transaction for atomicity. Test: a failed second insert leaves no orphaned access token.
- **server-mcp-7** — set_canvas_preview swallows encode errors. Bind the error and `log.warn({ err, canvasId: cv.id }, 'encodeRenditions failed')` before returning the user-facing fail. Test: encode failure logs.
- **server-mcp-4** — Duplicated McpRoutesDeps/McpToolDeps. Make `McpRoutesDeps extends McpToolDeps` (adding only OAuth extras); pass `deps` directly to `buildMcpServer`, removing the manual field-by-field reconstruction. Typecheck gate.
- **server-mcp-3** — set_canvas_preview zero coverage. Add tests: valid base64 → success + previewMode 'custom'; clear when custom → deletes renditions, reverts to auto; clear when already auto → no-op; invalid base64 → isError. Add `set_canvas_preview` + `rollback_canvas` to the AE1 cross-user ownership-rejection loop.

### P2
- **server-mcp-12** — clients.upsert non-atomic (DCR race). Replace SELECT-then-INSERT/UPDATE with `.onConflictDoUpdate({ target: clients.id, set: { clientInfo } })`. (Same defect as server-data-1's oauth half — coordinate to do it once.) Test: concurrent DCR does not 500; dual-dialect.
- **server-mcp-13** — unpublish_canvas informal error. Change to `fail('CANNOT_UNPUBLISH: this canvas isn\'t published')` to match the CODE: convention + HTTP route. Test: asserts the code prefix.
- **server-mcp-9** — canvasView omits settable fields. Extend `canvasView` (tool-kit.ts) to include `access, description, hasPassword, galleryListed, galleryTemplatable, gallerySummary, galleryTags, guestAiEnabled, guestAiCap, sharedExpiresAt, spaFallback, backendEnabled, disabledReason` so update_canvas is read-your-writes. Test: update_canvas response reflects a changed `access`.
- **server-mcp-10** — canvasView/previewVisible widened string types. Narrow the cv param to `{ status: CanvasStatus; previewMode: PreviewMode; … }` and remove the `as CanvasStatus` cast; fix spread-override call sites with `as const`. Typecheck gate.
- **server-mcp-15** — Duplicated dirty-computation. Export a shared `serializeDraftView(draft, liveManifest)` (or at minimum `isDirty`) and delegate from both `draftViewFor` (draft-tools.ts) and `draftView` (draft-api.ts). Test: both surfaces agree on dirty.
- **server-mcp-16** — previewMode 'off' tool description wrong. Rewrite the description: "off disables the screenshot preview — the preview URL returns 404 and the dashboard falls back to a procedurally generated cover. Upload a custom image with set_canvas_preview." Comment/description only.

> Deferred: **server-mcp-11** (server.ts god-module split), **server-mcp-17** (effectiveScreenshotsEnabled cache TTL — adds staleness), **server-mcp-14** (guest email audit PII retention).

---

## Unit: server-platform

Paths: `apps/server/src/realtime/hub.ts`, `apps/server/src/realtime/hub.test.ts`, `apps/server/src/email/`, `apps/server/src/routes/canvas-ai.ts`, `apps/server/src/docs/routes.ts`, `packages/shared/src/config/env.ts`

### P0
- **server-platform-1** — dropGatedNonOwners unguarded resolveCanvas. Wrap `deps.resolveCanvas(canvasId)` in try/catch mirroring `revalidateCanvas`; on error fail closed (drop all non-owner sockets, or all sockets conservatively) and log. Test: `resolveCanvas` throwing drops the gated sockets (not left alive).
- **server-platform-2** — Log mailer leaks magic link (SAFE HALF). In `email/log.ts` redact the body — log only `{ to, subject }`, never `msg.text`. In `config/env.ts` make the prod use of `EMAIL_DRIVER=log` a **LOUD WARNING** at boot, **NOT** a boot-failure; do **NOT** hard-reject `EMAIL_DRIVER=log`. Tests: log line contains no token/URL; prod+log emits a warning and still boots.

### P1
- **server-platform-7** — revalidateCanvas silent fail-closed. Log the caught error before failing closed in both the isPrincipalAllowed and isUserActive catch blocks (`deps.log?.error({ err, canvasId, userId }, 'realtime: … — failing closed')`); thread a logger via HubDeps. Test: injected DB error logs.
- **server-platform-4** — byCanvas never prunes empty Sets. In `dropConn` and `disconnect`, after deleting the Conn, `if (set.size === 0) byCanvas.delete(conn.canvasId)`. Test: after last disconnect, the canvas key is gone from the map.
- **server-platform-3** — AI /chat body-size cap (SAFE HALF). Add **only** a `bodyLimit` middleware (e.g. 256 KB) before the `/chat` handler. Do **NOT** add messages array-length or content/system string caps. Test: oversized body rejected; valid large conversation passes. (Same route as server-http-7 — coordinate to add one limit.)
- **server-platform-6** — No per-connection channel cap. Add `MAX_CHANNELS_PER_CONN` (e.g. 64) enforced at the top of `doSubscribe` with a `CHANNEL_LIMIT` error, and a channel-name byte-length check (e.g. 128 bytes) in `handleMessage`. Test: 65th distinct subscribe → CHANNEL_LIMIT; oversized channel name rejected.
- **server-platform-9** — renderGuestInvite returns `to:''` footgun. Change the return type to `Omit<EmailMessage, 'to'>`; the caller's `{ ...msg, to: email }` still works and forgetting `to` becomes a compile error. Typecheck gate.
- **server-platform-5** — Guest AI gate paths untested. Add two tests in canvas-ai.test.ts: guest principal + `guestAiEnabled=false` → 403 GUEST_AI_DISABLED; canvas spend ≥ `guestAiCap` → 429 GUEST_AI_CAP.
- **server-platform-8** — INVALID_FRAME/UNKNOWN_FRAME untested. Add tests: `handleMessage(conn, 'not-json')` → `{type:'error',code:'INVALID_FRAME'}`; `JSON.stringify({type:'bogus'})` → `{code:'UNKNOWN_FRAME'}`.

### P2
- **server-platform-11** — setupMailer switch implicit default for 'log'. Add explicit `case 'log': return logMailer(log);` and make `default` throw `new Error('unknown email driver')` for compile-time exhaustiveness. (Sequence with server-platform-2, same file area.) Test: unknown driver throws; log driver still works.
- **server-platform-12** — JSON.stringify(SEARCH_INDEX) per request. Pre-serialize once at module load (`const SEARCH_INDEX_JSON = JSON.stringify(SEARCH_INDEX)`), serve the cached string. Existing docs route test gate.
- **server-platform-15** — buildSkillZip blocking I/O. Pre-build the skill zip at mount time (call `buildSkillZip()` synchronously from `docsRoutes()` before any request), or convert to async I/O. Test: `/skill.zip` returns the memoized result; no first-request blocking.
- **server-platform-14** — Hub rate-limit window-expiry untested. Add a test: send MAX_MESSAGES_PER_MIN at `now`, assert cap fires, then send at `now + RATE_WINDOW_MS + 1` and assert success.
- **server-platform-16** — Hub revalidateCanvas throwing path untested. Add a test where `resolveCanvas` throws and assert all sockets close with `CLOSE_UNAUTHORIZED` (covers the server-platform-1 fix).
- **server-platform-10** — mailer.ts JSDoc "Three drivers". Update count to "Four drivers" listing smtp; fix the `canSend` JSDoc. Comment only.
- **server-platform-13** — hub Conn.sends "per-user" comment. Change to "per-connection rate limiting; a user with multiple connections has a separate window per connection." Comment only.

---

## Deferred backlog (no work planned this pass)

| id | unit | reason |
| --- | --- | --- |
| dashboard-16 | dashboard | High blast-radius refactor (api.ts, 38 consumers). |
| dashboard-17 | dashboard | (implicit with -16) Allowlist React-Query migration; partial error fix landed via dashboard-3. |
| packages-10 | packages | Behavior-changing (adds DB CHECK constraint). |
| server-auth-10 | server-auth | PII retention — excluded this pass. |
| server-auth-14 | server-auth | PII (drop UA col) — excluded; loses forensic signal. |
| server-canvas-9 | server-canvas | Behavior-changing (retry narrowing). |
| server-canvas-16 | server-canvas | Behavior-changing (drops exists() in deploy hot path). |
| server-canvas-15 | server-canvas | PII retention — excluded this pass. |
| server-data-12 | server-data | High blast-radius refactor (canvases.ts). |
| server-data-11 | server-data | Behavior-changing (session-touch/lastSeenAt gating). |
| server-http-14 | server-http | Behavior-changing (KV quota TOCTOU enforcement). |
| server-http-15 | server-http | PII (remove email from admin views) — admins trusted. |
| server-mcp-11 | server-mcp | High blast-radius refactor (server.ts). |
| server-mcp-17 | server-mcp | Behavior-changing (cache TTL adds staleness). |
| server-mcp-14 | server-mcp | PII retention — excluded this pass. |

> Note: dashboard-17 was in the FIX list (Allowlist React-Query migration). The full migration
> is high blast-radius and pairs with dashboard-16 (deferred); the **error-surfacing half**
> (the actual user-facing defect) is delivered by **dashboard-3**. If a fixer wants the full
> migration, do it in the dashboard unit after dashboard-3 lands. It is listed here for visibility,
> not as a second deferred decision — treat dashboard-3 as satisfying the user-visible part.

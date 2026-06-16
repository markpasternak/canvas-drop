# Canvas screenshots — requirements

- **Date:** 2026-06-16
- **Status:** Requirements (ready for `/ce-plan`) — revised after `/ce-doc-review`
- **Scope tier:** Deep — feature (architectural)
- **Author:** brainstorm with Mark

## Problem & outcome

canvas-drop has no real per-canvas imagery. Dashboard and gallery cards use
`GenerativeCover` (generated art, not the actual canvas), and link unfurls share a
single static branded `/og.png` (`apps/server/src/http/social-preview.ts`,
`apps/server/src/http/social-meta.ts`). So a published canvas looks generic
everywhere it's represented.

**Outcome:** every canvas gets a real screenshot of its published content, used as
dashboard/gallery covers and — **for public canvases only** — per-canvas link-unfurl
images. Screenshotting is slow, memory-heavy, and runs canvas-authored JS in a
browser, so it must be an **async, platform-triggered** operation — not inline in a
request.

This is **step 1** and is intentionally narrow: capture *our own* canvases,
triggered by *the platform*. It is not a general job runner and not an
author-facing screenshot capability (both explicitly deferred — see below).

## Decisions locked in this brainstorm

1. **Subject & trigger:** screenshot this instance's own deployed canvases,
   triggered by the platform. No arbitrary-URL / author-facing capability → **no
   SSRF surface from the trigger.**
2. **Altitude:** a **focused screenshot pipeline**, not a general async-job +
   scheduler subsystem. The jobs table is **screenshot-specific** (no `job_type`
   discriminator); a second job type means a new table/migration, not reuse. This
   keeps the "focused" decision honest (per scope review).
3. **Trigger timing:** **eager on publish**, **coalesced**. Publishing enqueues a
   capture of that version and **supersedes any still-pending capture for the same
   canvas** (only the latest version is worth capturing). Keyed to the version's
   identity so it auto-invalidates on republish.
4. **Capture scope (surfaces are NOT uniform):**
   - **Dashboard + gallery covers:** *all* canvases including private/gated — these
     surfaces are member-authenticated, so a real cover is safe and wanted.
   - **Per-canvas link-unfurl (OG) images:** **public_link canvases ONLY.** Gated
     canvases keep the existing generic card. Rationale below.
5. **Capture execution model:** **in-process worker** for v1; a **persistent
   headless browser reused across jobs with a fresh isolated context per job**,
   recycled every N jobs (memory-aligned — Chromium memory is the #1 constraint).
   Browser-per-job and a **separate worker process** are documented escape hatches
   if context isolation or in-process memory prove insufficient under load.
6. **Primitives are neutered during capture.** The capture principal authorizes
   **canvas-content read only**. The canvas's AI / realtime / outbound-network
   primitives are shimmed to no-op / blocked while a capture renders. No AI spend,
   no quota-attribution gap, no canvas-`fetch()`-to-internal-network path.

## Version identity (correction from review)

There is **no single version content hash** in the schema — versions are
`(canvas_id, number)` with a per-file `manifest` of content hashes
(`apps/server/src/db` / version model). The screenshot is therefore keyed to the
**version identity** (`canvasId` + version `number`, or a stable `versionId`) — to
be finalized in planning. References to a "versionHash" below mean this version
identity, not a content hash that doesn't exist.

## Why this architecture (and not a queue library)

The stack constrains the answer hard:

- The server is **single-process** and **SQLite-default on a single DO droplet**
  (the realtime hub is explicitly in-memory/single-process; §18 lists horizontal
  scaling as a known limit).
- The schema is **dual-dialect SQLite ↔ Postgres** (a sacred invariant).

So BullMQ (needs Redis), pg-boss / graphile-worker (Postgres-only) all break either
single-process simplicity or the dual-dialect invariant. The fit is a **DB job row
+ in-process worker** — dual-dialect-friendly, trivially correct on single-process
SQLite. It reuses the **storage interface** (local ↔ S3), the dual-dialect DB, and
(deferred) the realtime hub.

**Capture library: Playwright (already a dep), not pageres/Puppeteer.** A
higher-level lib like [pageres](https://github.com/sindresorhus/pageres) (Puppeteer
+ its own bundled Chromium, png/jpg only) was considered and rejected: it would add
a **second browser engine and a second Chromium** to ship/patch — doubling the M10
image-size/memory cost — to solve only the easy URL→image step we already have via
Playwright. It does not help with the hard parts (job table, capture principal,
primitive neutering, dual-dialect, access-gated serving), and its multi-size output
is redundant with sharp (which also gives us WebP, which pageres lacks). Its
browser-per-capture model also fights decision #5.

**Capture tooling is a new RUNTIME dependency (correction from review).** Playwright
and sharp are currently **build-time devDependencies** (`scripts/screenshots.mjs`),
not server runtime deps, and the production Docker image ships **no Chromium**.
Promoting capture to a runtime feature means: add Playwright + sharp to server
runtime deps, **bake Chromium + its system libraries into the M10 runtime image**,
and **budget its memory on the single VPS**. This is real packaging work and a
**hard dependency on M10**, not a free reuse.

### Flow

```
publish(canvasId, version)
  └─> coalesce: supersede any pending capture for canvasId
       └─> INSERT screenshot job (status=pending, key=version identity)   [dual-dialect, screenshot-specific table]
            └─> in-process worker claims one (lease); reuses persistent browser, fresh context
                 └─> render canvas@version via internal capture principal (primitives neutered)
                      └─> sharp -> WebP (OG-size master + derived crops) -> storage.put(<screenshot prefix>)
                           └─> mark job done
  covers/OG read via an ACCESS-GATED screenshot route (not a guessable public URL);
  GenerativeCover shown until a shot exists; failed == same placeholder (failure to admin/logs)
```

## In scope

- **Screenshot-specific dual-dialect jobs table** + in-process worker: lease/claim,
  retry with cap, hard wall-clock timeout, **single-worker concurrency (cap 1,
  config to 2)**, stuck-job reclaim on restart, **coalesce-to-latest** per canvas,
  and **failed-row cleanup** (failed jobs past a TTL are reclaimed, so the table
  doesn't grow unbounded).
- **Capture execution:** persistent browser + fresh context per job, recycled every
  N jobs; block JS dialogs (dialog-wedge hazard); hard wall-clock timeout; **primitives
  neutered** (decision #6).
- **Internal capture principal** for rendering gated/private canvas content:
  - A **server-minted, short-TTL credential scoped to exactly one canvas + version**,
    presented to the canvas-serve layer **as an HTTP header (never a URL query
    param** — avoids access-log/referrer exposure**)**, **never a user session,
    never client-supplied**.
  - **Enforcement lives in the canvas-serve access decision** (`decideCanvasAccess`
    in `apps/server/src/canvas/`): the capture principal is a distinct, explicit
    branch that grants **no capability beyond what the canvas owner already sees**
    (it captures content, it does not elevate). It must **not** bypass the
    password-gate into content a member couldn't otherwise view.
  - The **capture endpoint/path is unreachable from any client surface** — internal
    only.
  - **Mint and use are audit-logged** (lifecycle events, per the auth-invariant
    checklist).
- **Storage + serving:** master WebP at OG size (1200×630) plus sharp-derived
  card/gallery crops; stored under a dedicated screenshot prefix. Covers are served
  through an **access-gated route that re-checks canvas visibility** for the
  requester — a private canvas's screenshot is never fetchable by a guessable URL.
- **Surfaces:**
  - Dashboard + gallery cards: real cover for any canvas the viewer may see;
    `GenerativeCover` until a shot exists.
  - Link-unfurl (OG): **public_link canvases only** replace `/og.png` with their
    shot; all other canvases keep today's behavior.
- **Storage lifecycle:** a **sweep-style reclaim** (a screenshot whose version is no
  longer a live version is reclaimable) under the screenshot prefix, matching the
  existing best-effort `blob-gc` mark-sweep model rather than relying solely on
  event-coupled deletes (which can silently orphan on the constrained VPS). Canvas
  deletion also drops its screenshots.
- **Failure handling:** bounded retries, then leave the placeholder; failures
  surfaced to logs/admin (not silent). Pending and failed look identical to end
  users in v1 (an explicit decision, not an oversight).

## Deferred (revisit later, not now)

- **General async-job + scheduler subsystem** and **admin recurring jobs**.
  Generalize when a real second job type gives a better abstraction.
- **Author-facing `screenshot()` SDK primitive** for arbitrary URLs (the SSRF-heavy
  6th-capability version).
- **Realtime "cover ready" ping / live in-place swap.** v1 surfaces read the stored
  shot on load (next navigation/refresh shows it); no live swap. Moved here from an
  open question per scope review.
- **Manual "recapture" button** — trivial to add later; not core to step 1.
- **User-visible pending-vs-failed distinction** (badge/tooltip) — v1 shows the same
  placeholder for both.

## Out of this product's identity

- No phone-home / external screenshot service — capture is local, org-agnostic, MIT,
  12-factor.

## Key constraints (for planning)

- **Memory on a single VPS is the dominant constraint.** Chromium is heavy; this is
  why v1 uses a single recycled browser + per-job context and a concurrency cap of 1.
  The worker shares the server process, so the real risk is **concurrent serve/
  dashboard latency during a capture**, not publish latency (see success criteria).
- **Hard M10 dependency:** Chromium + libs must ship in the runtime image and fit the
  €15/mo single-VPS load-test budget (BUILD_BRIEF §13). This feature **changes M10's
  packaging and memory story** and should be sequenced with it.
- **Process restart:** in-flight jobs must be re-claimable after deploy/restart
  (lease timeout, not lost work).
- **Auth-shaped change:** the capture principal touches the §12.0 invariant → the plan
  must route through `/ce-code-review` and
  `docs/solutions/2026-06-13-auth-invariant-checklist.md`. **Test the rejection paths
  first** — wrong canvas, wrong version, expired, client-supplied, replay, and
  password-gate bypass — before the happy path.
- **Config is the only env reader**; enable flag, concurrency, timeout, recycle-N,
  TTLs are typed config behind the existing seams.

## Open questions (resolve in planning)

- **Capture origin across URL modes:** in subdomain mode each canvas has its own host;
  the worker must drive the correct internal origin (and satisfy the
  `frame-ancestors 'self'` CSP from commit 2b204a2) so canvases render in both
  path-mode (dev/self-host) and subdomain-mode (prod).
- Exact version-identity key (`versionId` vs `(canvasId, number)`) and job-table
  columns.
- Retry count, credential TTL, recycle-N, failed-row TTL — concrete values.
- Card/gallery crop dimensions + `object-fit` behavior (cover vs contain) so a
  white-background HTML page doesn't look jarring next to legacy generative covers.

## Success criteria

- Publishing a canvas results in a real WebP cover for that version, stored and served
  access-gated, with **no measurable impact on publish-request latency**.
- **Concurrent serve/dashboard p95 latency stays within bound while captures run**, and
  the capture queue **drains within a bounded time** under realistic publish churn
  (the metric the in-process model actually risks).
- Covers and (public_link) OG images show the real screenshot once present, and the
  `GenerativeCover` placeholder before that — no blank/broken state.
- **A private canvas's screenshot is never fetchable by an unauthorized requester**,
  and **no gated canvas's content appears in a link-unfurl image.**
- A spoofed, expired, wrong-canvas, wrong-version, replayed, or client-supplied
  capture credential **cannot render any canvas** (tested first).
- Captured canvases make **no AI spend and no outbound network calls** (primitives
  neutered).
- Worker survives a process restart mid-job (re-claimed, not lost) and never wedges on
  a slow/looping canvas (timeout fires); superseded pending jobs are dropped.
- Dual-dialect tests green on both SQLite and Postgres; CI matrix green.

## Dependencies & assumptions

- **New runtime dependency:** Playwright + sharp move to server runtime deps; Chromium
  + system libs ship in the M10 Docker image. Reuses storage interface + dual-dialect
  DB; realtime hub deferred.
- **Sequenced with M10** (not merely "informs" it): adds Chromium memory pressure to
  the single-VPS load test and changes the image build.
- v1 worker runs **in-process** with a single recycled browser; browser-per-job and a
  separate worker process are documented escape hatches.

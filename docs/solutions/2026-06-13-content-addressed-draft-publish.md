---
title: Content-addressed blobs + draft/publish model (M5) — seam, GC, and the blob-GC race
type: architecture
area: storage
date: 2026-06-13
---

M5 flipped canvas file storage from per-version copies to **content-addressed
per-canvas blobs** and added a **mutable draft + explicit Publish** model. This note
records the seam decisions and the one accepted race, so future work on storage,
pruning, or the editor builds on it rather than re-deriving it. Builds on
[[canvas-hosting-deploy-patterns]] and [[purge-vs-deploy-race]].

## The shape

- **Blobs are keyed `canvases/{canvasId}/blobs/{sha256}`** (`apps/server/src/canvas/storage-keys.ts`).
  Per-canvas, not global: dedup is within a canvas (all AE1 needs — edit 1 of 20 files
  → 1 new blob), refcounting is canvas-scoped, and purge deletes the whole prefix in one
  call. Global blobs would force cross-canvas refcount coordination and couple data
  lifecycles — rejected for the trust model ([[trust-model-calibration]]).
- **A version is a manifest** (`path → {size, hash, mime}`) over shared blobs — the shape
  was already there; only the storage *key* changed (`blobKey(canvasId, hash)` instead of
  `versions/{versionId}/{path}`). Serving, ETag, and caching are unchanged.
- **The draft is a dedicated `drafts` table** (one row per canvas, unique `canvas_id`),
  NOT a `versions.status='draft'` row. This keeps the per-canvas `number` sequence and
  keep-last-10 cap **published-only**, and leaves the existing rollback/prune race logic
  untouched.
- **Publish is a manifest op, not a byte copy** (`apps/server/src/draft/service.ts`).
  Editor writes upload blobs during editing, so Publish just creates a `ready` version
  with the draft's manifest + swaps the pointer. Restore copies a version's manifest into
  the draft. Both are effectively instant.

## Pruning is now two separate things

`versions.pruneBeyond` deletes version **rows** only (keep-last-10), keeping its atomic
live-pointer guard. **Blob reclamation is a separate per-canvas mark-sweep**
(`apps/server/src/canvas/blob-gc.ts`): live hash set = union of manifests across all
`ready` versions ∪ the draft; list the canvas blob prefix; delete blobs whose hash isn't
live. This one sweep subsumes both pruned-version blobs and draft-churn orphans (a file
edited h1→h2 leaves h1). **Never delete blobs inline** on a failed deploy or row-prune —
a blob may be shared with the live version; only the mark-sweep, which sees the whole live
set, may delete.

## The accepted race (blob GC vs concurrent publish)

A publish concurrent with the sweep could, in a narrow window, reference a blob the sweep
is about to delete. **Accepted** at D13 single-org scale, like [[purge-vs-deploy-race]]:
GC runs after row-pruning reading a fresh live set; blob puts are idempotent so a
re-publish/re-deploy re-writes any wrongly-swept blob; and serving already 404s a missing
asset rather than crashing. Revisit if canvases get multi-writer or much higher publish
concurrency.

## Gotchas worth keeping

- **`stale` belongs in the engine, not each route.** Any direct publish (Bearer deploy
  API, folder/ZIP, paste) supersedes a held draft. Marking the draft stale inside
  `engine.deploy` (after the pointer swap) covers the *entire* direct-publish surface —
  including the programmatic API — in one place. The editor's own Publish goes through the
  draft service (manifest snapshot), not `engine.deploy`, so it never wrongly self-stales.
- **Draft preview stays on the dashboard origin.** `GET /api/canvases/:id/preview/*`
  (owner-only, `no-store`) streams draft blobs via the shared `asset-resolver`. The public
  canvas origin only ever serves published versions — drafts never transit it.
- **Raw-file fetches break the JSON auth-expiry heuristic.** The dashboard's shared
  `request()` treats a 2xx non-JSON body as a proxy login page (session expiry). Draft
  file content is legitimately non-JSON (HTML/CSS/JS), so `api.getDraftFile` narrows
  auth-expiry to `401 || res.redirected`. Any future raw-body GET must do the same or it
  will redirect to login on every successful load.
- **CodeMirror is lazy-loaded.** The editor route is its own chunk (~520 kB) so CodeMirror
  only loads when the editor opens — it never weighs on the dashboard's initial bundle.

## Editor gotchas caught in review (post-merge fixes)

- **Draft preview iframe must NOT use `allow-same-origin`.** The preview is served from the
  dashboard origin, and an admin can preview *another user's* draft. With
  `sandbox="allow-scripts allow-same-origin"` the framed draft runs scripts same-origin with
  the dashboard — a hostile draft would ride the admin's session and hit `/api`. Use
  `sandbox="allow-scripts allow-forms"` (opaque origin); the preview only needs to render
  static bytes, not call same-origin APIs.
- **Binary assets must be MIME-gated out of the text editor.** Loading an image/font's bytes
  into CodeMirror and autosaving re-encodes them as UTF-8 text and corrupts the file. Gate on
  the manifest's `mime` (`isBinaryMime`): images get an inline `<img>` preview, other binaries
  a placeholder; both are changed only via **Replace/upload** (raw `PUT` with a `Blob` body),
  never the text editor. Adding files = "new empty text file" OR drag-drop/picker upload.
- **The autosave buffer must be bound to its file.** A single shared `bufferRef` + an
  unconditional flush silently writes the wrong (or empty) content into a file when switching
  files or publishing. Track `bufferPathRef` (which file the buffer is for), `loadedRef` (clean
  baseline), and a dirty flag; flush only a genuinely-edited buffer back to *its* path, reset on
  load, and clear the debounce timer on unmount. Four reviewer personas converged on this.
- **A missing blob must surface, not blank.** If the canvas predates content-addressing (or a
  blob is genuinely absent), `getDraftFile` 404s — render an explicit error state, not an empty
  editor. (Locally: pre-M5 dev data under `storage/versions/` won't resolve; the build is
  greenfield, so wipe `apps/server/data` to reset.)
- **Blob GC: list storage before reading the live set.** Reading the version/draft live set
  *after* `storage.list()` narrows the draft-write-vs-sweep window cheaply — a manifest entry
  committed before the live read is preserved. The draft-write case (unlike publish) has no
  idempotent re-write to self-heal, so this ordering matters.
- **WYSIWYG/visual HTML editing is deferred to its own milestone** — HTML round-tripping +
  sanitization is a large surface; the live preview pane is the v1 "what you get" loop.

## On-page text editing (M5 polish) — how it works and its caveats

The editor gained a **Code / On-page** toggle. On-page mode makes the rendered single-HTML
page editable in place (server injects a shim when the draft preview is requested with
`?edit=1`), with a floating `execCommand` formatting toolbar. Non-obvious bits worth keeping:

- **Availability is MIME-gated to a single HTML page.** `singleHtmlFile()` keys on the
  manifest `mime` being `text/html` — the SAME signal the server's `rootEntry`/`soleHtmlEntry`
  uses to pick the preview entry — so the dashboard never offers on-page mode for a file the
  preview can't render as the page (e.g. a lone `.xhtml` the server downgrades to `text/plain`).
  Keep these two in lockstep; an extension-based check would drift from the server.
- **Sandbox + postMessage, not same-origin.** The on-page iframe is `sandbox="allow-scripts
  allow-forms allow-modals"` — **no `allow-same-origin`**, so the page runs in an opaque origin
  and can't touch the dashboard session. `allow-modals` is added (vs the read-only preview)
  only so the link toolbar's `prompt()` works; it grants no same-origin/navigation. The shim
  `postMessage`s to `parent` with targetOrigin `"*"` (the opaque frame can't know the parent
  origin); the parent validates by **`e.source === iframe.contentWindow`**, NOT `e.origin`
  (which is `"null"` for every opaque frame). That source check is the sole authenticity gate —
  it has a regression test (`onpage-editor.test.tsx`).
- **Strip injected nodes BY REFERENCE, never by attribute query.** The shim captures its own
  `<script>` via `document.currentScript` at load and the toolbar element it creates, then on
  serialize detaches exactly those two nodes (synchronously, no paint), reads
  `documentElement.outerHTML`, and re-attaches. A `querySelectorAll("[data-cd-edit]")` strip
  would **delete the user's own markup** if their HTML ever used that attribute — a real
  data-loss bug a review caught.
- **Invalidate the code editor's `draft-file` query after an on-page save.** On-page writes the
  HTML file directly; if you don't `qc.invalidateQueries(["draft-file", id, htmlFile.path])`,
  switching back to Code shows the stale pre-on-page buffer and the next code edit silently
  **overwrites the on-page edits**. (`useSaveDraftFile` deliberately does NOT invalidate
  draft-file — that would reset the buffer mid-typing during code autosave; only `onPageSave`
  invalidates.)
- **Accepted caveat — the round-trip reformats HTML.** On-page saves the re-serialized
  `documentElement.outerHTML` (not a patch of source bytes), so `designMode` normalization
  (attribute reordering/re-quoting, void-tag rewriting, entity re-encoding, an implicit `<head>`,
  dropped pre-`<html>` comments) **accumulates** across edit→save→reload. Fine for a generated /
  pasted single page (the use case); lossy for hand-tuned multi-file markup — which is why on-page
  is gated to a single static HTML page. Document, don't "fix" (a true fix needs structural
  diff/patch, out of scope).

## Tab layout (M5 polish)

All canvas detail tabs run the **full width** of the shell (the app shell + breadcrumb + tab
chrome are the constant). `TabContentFrame` is just `space-y-4 + className`; a tab wanting a
narrower column does it with its own `className` (e.g. Settings' `lg:grid-cols-[180px_minmax(0,1fr)]`).
Earlier per-tab `tabWidths` variants were removed after they all collapsed to full-width (dead,
misleading config).

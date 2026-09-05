import { createHash } from "node:crypto";
import type { Config } from "@canvas-drop/shared";
import type { Canvas, Draft, Manifest, Version } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import { looksLikeApiKey } from "../canvas/api-key.js";
import { collectGarbage } from "../canvas/blob-gc.js";
import { type RootEntry, rootEntry } from "../canvas/manifest.js";
import { decodeText, isTextContentType, mimeFor } from "../canvas/mime.js";
import { blobKey } from "../canvas/storage-keys.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { DraftsRepository } from "../db/repositories/drafts.js";
import type { UploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { createPendingVersionWithRetry, KEEP_VERSIONS } from "../deploy/constants.js";
import { DeployError, DraftConflictError, LIMITS } from "../deploy/errors.js";
import { normalizeEntryPath } from "../deploy/validate.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";

export interface DraftServiceDeps {
  config: Config;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
  audit: AuditLog;
  log: Logger;
  /**
   * In-flight upload sessions (plan 003). Threaded into the blob-GC live set so a
   * publish-triggered sweep can't reclaim blobs that a concurrent staged upload
   * session references only via its (not-yet-finalized) manifest, mirroring the
   * deploy engine's prune() (review server-canvas-2). Optional (absent in tests
   * that don't exercise the staged-upload race).
   */
  uploadSessions?: UploadSessionsRepository;
  /**
   * Screenshot capture trigger (plan 004 / U6+U12). The effective-gated, best-effort
   * `screenshotTrigger` — it checks env-available AND admin-enabled internally and never
   * throws, so publishing just calls `enqueue` unconditionally. Optional (absent in tests
   * that don't exercise capture).
   */
  screenshots?: import("../screenshots/trigger.js").ScreenshotTrigger;
  /** Resolves writer names for conflict messages and draft views (editor-roles plan,
   *  KTD8). Optional: absent ⇒ ids only. */
  users?: Pick<UsersRepository, "findById" | "findByIds">;
}

/**
 * Per-mutation options (editor-roles plan, KTD8/R17):
 *  - `actor`: who is writing — stamped on every touched entry (`updatedBy`/`updatedAt`).
 *  - `expectedHash`: the hash the client loaded for the path (`none` for a path it
 *    believes absent). A mismatch refuses with {@link DraftConflictError}. When ABSENT
 *    the write is unconditioned — except that a different last writer on the entry
 *    still refuses (default-on for the two-editor case; inert for a solo actor).
 */
export interface DraftMutationOptions {
  actor?: string;
  expectedHash?: string;
}

/** A published version's manifest is content, not authorship: drop the writer stamps. */
export function stripEntryMeta(manifest: Manifest): Manifest {
  const out: Manifest = {};
  for (const [path, e] of Object.entries(manifest)) {
    out[path] = { size: e.size, hash: e.hash, mime: e.mime };
  }
  return out;
}

/** Stamp every entry of a manifest with one writer (restore / publish-time refresh). */
export function stampAll(manifest: Manifest, actor: string | undefined, now: number): Manifest {
  if (!actor) return manifest;
  const out: Manifest = {};
  for (const [path, e] of Object.entries(manifest)) {
    out[path] = { ...e, updatedBy: actor, updatedAt: now };
  }
  return out;
}

/** One file of the draft as both transports describe it (parity): content metadata plus
 *  the per-entry hash and writer, so a client can send the precondition on its next save. */
export interface DraftFileView {
  path: string;
  size: number;
  mime: string;
  hash: string;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: number | null;
}

export interface PublishResult {
  version: number;
  versionId: string;
  fileCount: number;
  totalBytes: number;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const manifestStats = (manifest: Manifest): { fileCount: number; totalBytes: number } => {
  let totalBytes = 0;
  for (const entry of Object.values(manifest)) totalBytes += entry.size;
  return { fileCount: Object.keys(manifest).length, totalBytes };
};

/**
 * Draft lifecycle (M5, R10–R15). Each canvas has exactly one mutable draft — a
 * manifest over content-addressed blobs. The in-browser editor mutates the draft
 * (writes a blob + updates the manifest, NEVER a version); an explicit Publish
 * snapshots the manifest into a new immutable version and swaps the live pointer.
 * Restore copies a published version's manifest back into the draft.
 *
 * Blobs written here are reclaimed by the same per-canvas mark-sweep GC as deploys
 * (KTD-4) — draft churn (a file edited h1→h2) leaves h1 for the next sweep.
 */
/** CAS attempts before a mutation gives up on a draft under heavy concurrent writing. */
const MAX_COMMIT_ATTEMPTS = 5;

export function draftService(deps: DraftServiceDeps) {
  /**
   * Commit a manifest mutation with optimistic concurrency (review #4): read the draft,
   * let `mutate` build the next manifest from the CURRENT one (re-running its own
   * precondition), then compare-and-swap on the row's `updatedAt`. A miss means another
   * writer landed in between — re-read and rebuild, so a disjoint-path change merges and a
   * same-path change is refused by the precondition as DRAFT_CONFLICT, never overwritten.
   */
  async function commitManifest(
    canvas: Canvas,
    mutate: (current: Manifest, draft: Draft) => Promise<Manifest | null> | Manifest | null,
  ): Promise<Draft> {
    let draft = await service.getOrCreate(canvas);
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      const next = await mutate(draft.manifest as Manifest, draft);
      if (next === null) return draft; // no-op mutation
      const saved = await deps.drafts.setManifest(canvas.id, next, draft.updatedAt);
      if (saved) return saved;
      const fresh = await deps.drafts.getByCanvas(canvas.id);
      if (!fresh) throw new DeployError("DRAFT_GONE", "the draft no longer exists");
      draft = fresh;
    }
    throw new DeployError(
      "DRAFT_BUSY",
      "the draft is being changed by other writers — retry in a moment",
    );
  }

  /** The precondition check (KTD8), shared by write / delete / rename. */
  async function assertFresh(
    path: string,
    current: Manifest[string] | undefined,
    opts: DraftMutationOptions,
  ): Promise<void> {
    const currentHash = current?.hash ?? "none";
    const conflicted =
      opts.expectedHash !== undefined
        ? opts.expectedHash !== currentHash
        : // Unconditioned: refuse only when the entry's last writer is a DIFFERENT user —
          // the two-editor case; a solo actor (or an unstamped legacy entry) never conflicts.
          !!(opts.actor && current?.updatedBy && current.updatedBy !== opts.actor);
    if (!conflicted) return;
    const writer =
      current?.updatedBy && deps.users ? await deps.users.findById(current.updatedBy) : null;
    throw new DraftConflictError({
      path,
      currentHash,
      updatedBy: current?.updatedBy ?? null,
      updatedByName: writer?.name ?? null,
      updatedAt: current?.updatedAt ?? null,
    });
  }

  const service = {
    /**
     * Describe a draft for a client — the file list with per-entry hash + writer (so the
     * next save can carry the precondition), the fork-point, and the dirty / stale flags.
     * ONE projection for the HTTP draft view and the MCP `get_draft` (parity).
     */
    async describe(
      draft: Draft,
      liveManifest: Manifest | null,
    ): Promise<{
      files: DraftFileView[];
      stale: boolean;
      baseVersionId: string | null;
      updatedAt: number;
      dirty: boolean;
      changes: Array<{ path: string; kind: "added" | "modified" | "deleted" }>;
      entry: RootEntry;
    }> {
      const manifest = draft.manifest as Manifest;
      const writerIds = [
        ...new Set(
          Object.values(manifest)
            .map((e) => e.updatedBy)
            .filter((id): id is string => !!id),
        ),
      ];
      const names = new Map(
        deps.users && writerIds.length > 0
          ? (await deps.users.findByIds(writerIds)).map((u) => [u.id, u.name])
          : [],
      );
      const files = Object.entries(manifest)
        .map(([path, e]) => ({
          path,
          size: e.size,
          mime: e.mime,
          hash: e.hash,
          updatedBy: e.updatedBy ?? null,
          updatedByName: e.updatedBy ? (names.get(e.updatedBy) ?? null) : null,
          updatedAt: e.updatedAt ?? null,
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const live = liveManifest ?? {};
      const changes: Array<{ path: string; kind: "added" | "modified" | "deleted" }> = [];
      for (const path of new Set([...Object.keys(manifest), ...Object.keys(live)])) {
        if (!Object.hasOwn(manifest, path)) changes.push({ path, kind: "deleted" });
        else if (!Object.hasOwn(live, path)) changes.push({ path, kind: "added" });
        else if (manifest[path]?.hash !== live[path]?.hash)
          changes.push({ path, kind: "modified" });
      }
      changes.sort((a, b) => a.path.localeCompare(b.path));
      return {
        files,
        stale: draft.stale,
        baseVersionId: draft.baseVersionId,
        updatedAt: draft.updatedAt,
        dirty: changes.length > 0,
        changes,
        entry: rootEntry(manifest),
      };
    },

    /** The canvas's draft, creating it from the live version (or empty) on first touch (R10). */
    async getOrCreate(canvas: Canvas): Promise<Draft> {
      const existing = await deps.drafts.getByCanvas(canvas.id);
      if (existing) return existing;
      let manifest: Manifest = {};
      let baseVersionId: string | null = null;
      if (canvas.currentVersionId) {
        const live = await deps.versions.findById(canvas.currentVersionId);
        if (live?.status === "ready" && live.manifest) {
          manifest = live.manifest as Manifest;
          baseVersionId = live.id;
        }
      }
      try {
        return await deps.drafts.create({ canvasId: canvas.id, manifest, baseVersionId });
      } catch (err) {
        // Two concurrent first-touch requests (e.g. GET /draft + an autosave PUT on
        // first open) both see no draft and both insert; the unique canvas_id index
        // makes the loser throw. Re-read and return the winner's row (insert-or-get).
        const raced = await deps.drafts.getByCanvas(canvas.id);
        if (raced) return raced;
        throw err;
      }
    },

    /** Read a draft file's bytes, or null if the path isn't in the draft (R13 raw read). */
    async readFile(canvas: Canvas, path: string): Promise<Uint8Array | null> {
      const draft = await deps.drafts.getByCanvas(canvas.id);
      const entry = draft ? (draft.manifest as Manifest)[path] : undefined;
      if (!entry) return null;
      return deps.storage.get(blobKey(canvas.id, entry.hash));
    },

    /**
     * Write/replace a draft file: hash → blob → manifest. No version (R11/AE1).
     * `mustNotExist` makes it a *create* (used by "Add a file"): if the path is
     * already in the draft it throws PATH_EXISTS instead of silently truncating the
     * existing file's content to the new (often empty) bytes.
     */
    async writeFile(
      canvas: Canvas,
      rawPath: string,
      bytes: Uint8Array,
      opts: { mustNotExist?: boolean } & DraftMutationOptions = {},
    ): Promise<Draft> {
      const path = normalizeEntryPath(rawPath);
      if (path === null) {
        throw new DeployError("INVALID_PATH", `not a writable file path: ${rawPath}`, rawPath);
      }
      const size = bytes.byteLength;
      if (size > LIMITS.maxFileBytes) {
        throw new DeployError("FILE_TOO_LARGE", `${path} exceeds 25 MB`, path);
      }
      const hash = sha256(bytes);
      const mime = mimeFor(path).contentType;
      // Blob first (content-addressed, idempotent), then the manifest under CAS.
      if (!(await deps.storage.exists(blobKey(canvas.id, hash)))) {
        await deps.storage.put(blobKey(canvas.id, hash), bytes);
      }
      if (isTextContentType(mime) && looksLikeApiKey(decodeText(bytes))) {
        // Warn (don't block) if a text file edited in the in-browser editor / via the
        // MCP write_draft_file channel appears to embed a canvas API key (§12.1.2 —
        // keys are server-side only). Mirrors the deploy engine's deploy-time scan so
        // every ingestion path surfaces the same lint (review server-canvas-11).
        deps.log.warn(
          { canvasId: canvas.id, path },
          "draft file may contain a canvas API key — remove it before publishing",
        );
      }
      return commitManifest(canvas, async (current) => {
        if (opts.mustNotExist && current[path]) {
          throw new DeployError("PATH_EXISTS", `a file already exists at ${path}`, path);
        }
        await assertFresh(path, current[path], opts);
        const next: Manifest = { ...current };
        next[path] = {
          size,
          hash,
          mime,
          ...(opts.actor ? { updatedBy: opts.actor, updatedAt: Date.now() } : {}),
        };
        const stats = manifestStats(next);
        if (stats.totalBytes > LIMITS.maxCanvasBytes) {
          throw new DeployError("CANVAS_TOO_LARGE", "draft exceeds 100 MB total");
        }
        if (stats.fileCount > LIMITS.maxFiles) {
          throw new DeployError("TOO_MANY_FILES", `draft exceeds ${LIMITS.maxFiles} files`);
        }
        return next;
      });
    },

    /** Remove a file from the draft (blob left for GC). Honours the precondition (KTD8). */
    async deleteFile(
      canvas: Canvas,
      rawPath: string,
      opts: DraftMutationOptions = {},
    ): Promise<Draft> {
      // Manifest keys are always normalized (no leading './', no backslashes), so
      // normalize the lookup key too — an agent passing './index.html' must resolve
      // to the real file rather than spuriously 404 (review server-canvas-3, mirrors
      // writeFile). null = not a writable file path at all.
      const path = normalizeEntryPath(rawPath);
      if (path === null) {
        throw new DeployError("INVALID_PATH", `not a writable file path: ${rawPath}`, rawPath);
      }
      return commitManifest(canvas, async (current) => {
        const next: Manifest = { ...current };
        if (!next[path]) throw new DeployError("INVALID_PATH", `no such draft file: ${path}`, path);
        await assertFresh(path, next[path], opts);
        delete next[path];
        return next;
      });
    },

    /** Move a file within the draft (same blob, new path) — rename or relocate. The
     *  precondition (KTD8) applies to the SOURCE entry; the target must not exist. */
    async renameFile(
      canvas: Canvas,
      rawFrom: string,
      rawTo: string,
      opts: DraftMutationOptions = {},
    ): Promise<Draft> {
      // Normalize BOTH endpoints against the (always-normalized) manifest keys so a
      // conventional relative-style source like './foo.html' resolves to the real
      // file instead of a spurious INVALID_PATH (review server-canvas-3).
      const from = normalizeEntryPath(rawFrom);
      if (from === null) {
        throw new DeployError("INVALID_PATH", `not a writable file path: ${rawFrom}`, rawFrom);
      }
      const to = normalizeEntryPath(rawTo);
      if (to === null) {
        throw new DeployError("INVALID_PATH", `not a writable file path: ${rawTo}`, rawTo);
      }
      return commitManifest(canvas, async (current) => {
        const next: Manifest = { ...current };
        const entry = next[from];
        if (!entry) throw new DeployError("INVALID_PATH", `no such draft file: ${from}`, from);
        if (to === from) return null; // no-op rename (after normalization) — nothing to do
        await assertFresh(from, entry, opts);
        // Renaming onto a different existing file would silently destroy that file —
        // refuse it (the editor surfaces PATH_EXISTS as inline validation).
        if (next[to]) {
          throw new DeployError("PATH_EXISTS", `a file already exists at ${to}`, to);
        }
        delete next[from];
        next[to] = opts.actor ? { ...entry, updatedBy: opts.actor, updatedAt: Date.now() } : entry;
        return next;
      });
    },

    /**
     * Freeze the draft into a new immutable published version and swap the live
     * pointer (R12/AE2/AE3). Blobs already exist (written during editing), so this
     * is a manifest + pointer operation, not a byte copy. After publishing, the
     * draft equals the live version (stale cleared, base = the new version).
     */
    async publish(canvas: Canvas, actorId: string): Promise<PublishResult> {
      const draft = await service.getOrCreate(canvas);
      // A version is content, not authorship: the frozen manifest drops writer stamps.
      const manifest = stripEntryMeta(draft.manifest as Manifest);
      const { fileCount, totalBytes } = manifestStats(manifest);
      if (fileCount === 0) {
        throw new DeployError("EMPTY_DEPLOY", "nothing to publish — the draft is empty");
      }

      const version = await service.createReadyVersion(canvas.id, actorId, manifest, {
        fileCount,
        totalBytes,
      });
      await deps.canvases.setCurrentVersion(canvas.id, version.id);
      deps.audit.recordAudit({
        action: "publish",
        actorId,
        targetId: canvas.id,
        meta: { version: version.number, fileCount },
      });
      // The draft now mirrors the freshly published version. The version is already
      // live, so a failure here must NOT fail the publish (it would surface a 500 for
      // an action that actually succeeded, and a retry would double-publish). Best-
      // effort: log and continue; the worst case is a draft that still shows
      // unpublished-changes until the next edit/publish.
      // Compare-and-swap against the snapshot we published (review #4): a save that
      // landed after the snapshot is real unpublished work — leave the draft alone so it
      // shows as dirty against the new version instead of being erased.
      await deps.drafts
        .resetToBase(canvas.id, manifest, version.id, draft.updatedAt)
        .then((reset) => {
          if (!reset)
            deps.log.info(
              { canvasId: canvas.id },
              "post-publish draft reset skipped — the draft changed during publish",
            );
        })
        .catch((err) =>
          deps.log.warn({ err, canvasId: canvas.id }, "post-publish draft reset failed"),
        );

      // Schedule a screenshot capture of the freshly published version (plan 004 / U6).
      // The trigger owns the effective-enabled gate (env-available AND admin-enabled) and
      // is best-effort by contract (U12); the extra `.catch` is a defensive belt — a
      // skipped/failed enqueue must never fail a publish that already succeeded.
      await deps.screenshots
        ?.enqueue(canvas, version.id)
        .catch((err) => deps.log.warn({ err, canvasId: canvas.id }, "screenshot enqueue failed"));

      // Prune old rows + reclaim unreferenced blobs, async + best-effort.
      service.pruneAndCollect(canvas.id);
      return { version: version.number, versionId: version.id, fileCount, totalBytes };
    },

    /** Restore a published version's files into the draft (R14/AE3) — never edits the version. */
    async restore(canvas: Canvas, versionNumber: number, actor?: string): Promise<Draft> {
      const target = await deps.versions.findReadyByNumber(canvas.id, versionNumber);
      if (!target?.manifest) {
        // A missing/pruned target version is a "not found", not a path-validation
        // error — VERSION_UNAVAILABLE maps to 404 (matching the management rollback
        // route's missing-version response), not INVALID_PATH's 400 (review
        // server-canvas-7).
        throw new DeployError("VERSION_UNAVAILABLE", `no ready version ${versionNumber}`);
      }
      // Every entry moves: stamp them all with the restoring actor (KTD8) so a save
      // pinned to the pre-restore hash is refused (this replaces `If-Draft-Base`). The
      // reset is a compare-and-swap like every other manifest write (review #4); a
      // restore replaces the whole draft, so a miss just re-reads and re-applies.
      let draft = await service.getOrCreate(canvas);
      for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
        const reset = await deps.drafts.resetToBase(
          canvas.id,
          stampAll(target.manifest as Manifest, actor, Date.now()),
          target.id,
          draft.updatedAt,
        );
        if (reset) return reset;
        const fresh = await deps.drafts.getByCanvas(canvas.id);
        if (!fresh) throw new DeployError("DRAFT_GONE", "the draft no longer exists");
        draft = fresh;
      }
      throw new DeployError(
        "DRAFT_BUSY",
        "the draft is being changed by other writers — retry in a moment",
      );
    },

    /** Create a `ready` version with the given manifest, retrying on a number collision. */
    async createReadyVersion(
      canvasId: string,
      actorId: string,
      manifest: Manifest,
      stats: { fileCount: number; totalBytes: number },
    ): Promise<Version> {
      // Shared collision-retry for the pending row (review server-canvas-10), then
      // mark it ready. markReady runs outside the retry so a transient markReady
      // failure can't spuriously re-pick a version number.
      const pending = await createPendingVersionWithRetry(
        deps.versions,
        canvasId,
        actorId,
        "editor",
      );
      return deps.versions.markReady(pending.id, { ...stats, manifest });
    },

    /** Fire-and-forget row prune + blob GC, mirroring the deploy engine's prune. */
    pruneAndCollect(canvasId: string): void {
      void (async () => {
        try {
          await deps.versions.pruneBeyond(canvasId, KEEP_VERSIONS);
        } catch (err) {
          deps.log.error({ err, canvasId }, "publish row prune failed (live unaffected)");
        }
        await collectGarbage(
          {
            versions: deps.versions,
            drafts: deps.drafts,
            storage: deps.storage,
            log: deps.log,
            // Keep blobs referenced by in-flight staged upload sessions in the live
            // set so a concurrent publish doesn't sweep them out from under a staged
            // finalize (review server-canvas-2, mirrors the deploy engine's prune()).
            uploadSessions: deps.uploadSessions,
          },
          canvasId,
        );
      })().catch((err) => deps.log.error({ err, canvasId }, "publish prune dispatch failed"));
    },
  };

  return service;
}

export type DraftService = ReturnType<typeof draftService>;

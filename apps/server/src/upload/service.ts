import { createHash } from "node:crypto";
import type { Config } from "@canvas-drop/shared";
import type { Canvas, Manifest, UploadSession } from "@canvas-drop/shared/db";
import type { OrgMembershipResolver } from "../auth/org-membership.js";
import { looksLikeApiKey } from "../canvas/api-key.js";
import { memberPrincipal } from "../canvas/authorization.js";
import { soleHtmlEntry } from "../canvas/manifest.js";
import { decodeText, isTextContentType, mimeFor } from "../canvas/mime.js";
import { resolveManagementGrant } from "../canvas/role.js";
import { blobKey, canvasBlobPrefix, hashFromBlobKey } from "../canvas/storage-keys.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { UploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { DeployEngine, DeployResult } from "../deploy/engine.js";
import { DeployError, LIMITS, PublicationConflictError } from "../deploy/errors.js";
import { type FileInput, fromFilesArray } from "../deploy/ingest.js";
import {
  alreadyCurrentOutcome,
  type Coordination,
  type CoordinationInput,
  normalizeCoordination,
} from "../deploy/publication.js";
import { normalizeEntryPath } from "../deploy/validate.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { generateUploadId, hashUploadId } from "./handle.js";

/** How long an upload session lives before finalize must have happened (plan 003). */
export const UPLOAD_TTL_MS = 15 * 60 * 1000;
/** Stale-finalize lease: a crashed/transient finalize older than this can be re-claimed. */
export const FINALIZE_LEASE_MS = 60 * 1000;

/** One declared file in a begin manifest: server computes mime; client gives path+hash+size. */
export interface ManifestInput {
  path: string;
  hash: string;
  size: number;
}

export interface BeginResult {
  uploadId: string;
  missingHashes: string[];
  /**
   * Deployment coordination (KTD11 / R12): when the requested release is live already, no
   * session is opened — this carries the `already_current` result instead and `uploadId`
   * is the empty string. Callers check this field first.
   */
  alreadyCurrent?: DeployResult;
}

export interface UploadServiceDeps {
  config: Config;
  canvases: CanvasesRepository;
  users: UsersRepository;
  uploadSessions: UploadSessionsRepository;
  storage: StorageDriver;
  engine: DeployEngine;
  log?: Logger;
  /** Live org-membership resolver (editor-roles plan, KTD2): finalize re-resolves the
   *  actor's membership on use so an editor's grant is checked against the LIVE org
   *  set. Optional — omitted (focused tests) ⇒ an empty set, which under inert tenancy
   *  changes nothing and under active tenancy admits only the owner. */
  orgMembership?: OrgMembershipResolver;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Two-channel upload service (plan 003, U2). The shared core both the keyed
 * Deploy-API routes (U5) and the MCP tools (U6) call — no parallel logic.
 *
 *   begin → record the canonical manifest + a single-use handle; report which
 *           blobs are missing (content-addressed skip-unchanged)
 *   stage → write the missing blobs into the shared content-addressed store
 *   finalize → idempotent single-use: re-validate identity + ownership, assert
 *           every manifest hash is present, then commit a ready version via the
 *           engine's shared commit tail.
 *
 * Identity (`callerId`) and the target `canvasId` are always supplied by the
 * gated front-ends (the MCP role gate / Deploy-API `authCanvas`); the service binds
 * each session to that ACTOR (the `owner_id` column of `upload_sessions` holds the
 * actor who began it — owner or editor), re-checks the binding on every staging op,
 * and re-resolves the actor's role on the canvas at finalize (block-after-issue).
 */
export function uploadService(deps: UploadServiceDeps) {
  const now = deps.now ?? Date.now;

  /** Resolve a session by plaintext uploadId, enforcing actor + canvas binding + liveness.
   *  A session is usable only by the actor who began it (editor-roles plan, U3). */
  async function requireStageable(
    handleHash: string,
    callerId: string,
    canvasId: string,
  ): Promise<UploadSession> {
    const s = await requireBound(handleHash, callerId, canvasId);
    if (s.consumedAt) throw new DeployError("UPLOAD_ALREADY_FINALIZED", "already finalized");
    return requireUnexpired(s);
  }

  /** The session bound to this actor and canvas, whatever its lifecycle state. */
  async function requireBound(
    handleHash: string,
    callerId: string,
    canvasId: string,
  ): Promise<UploadSession> {
    const s = await deps.uploadSessions.findByHandleHash(handleHash);
    // One opaque code for unknown / wrong-actor / wrong-canvas — no existence leak.
    if (!s || s.actorId !== callerId || s.canvasId !== canvasId) {
      throw new DeployError("UPLOAD_HANDLE_INVALID", "no such upload session");
    }
    return s;
  }

  function requireUnexpired(s: UploadSession): UploadSession {
    if (s.expiresAt <= now()) throw new DeployError("UPLOAD_EXPIRED", "upload session expired");
    return s;
  }

  async function putBlobIfAbsent(canvasId: string, hash: string, bytes: Uint8Array): Promise<void> {
    const key = blobKey(canvasId, hash);
    if (await deps.storage.exists(key)) return;
    await deps.storage.put(key, bytes);
  }

  /** Stage one blob: verify its size + hash, write it, record it staged. */
  async function stageOne(session: UploadSession, hash: string, bytes: Uint8Array): Promise<void> {
    // Per-file cap on the ACTUAL bytes — both staging channels share it (the HTTP
    // route also has a body limit; the MCP add_files channel relies on this).
    if (bytes.byteLength > LIMITS.maxFileBytes) {
      throw new DeployError("FILE_TOO_LARGE", `staged blob exceeds ${LIMITS.maxFileBytes} bytes`);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== hash) {
      throw new DeployError("BLOB_HASH_MISMATCH", `blob bytes do not match hash ${hash}`);
    }
    // Finalize sums the manifest's DECLARED sizes for the canvas cap, so tie the
    // declared size to reality here: a client must not declare a small size and
    // stage large bytes (that would under-report totalBytes and slip past the
    // aggregate cap). Referenced (manifest) hashes carry an authoritative size.
    const manifest = (session.manifest as Manifest | null) ?? {};
    const expected = Object.values(manifest).find((e) => e.hash === hash);
    if (!expected) {
      // A blob outside the begin-manifest can never be finalized; accepting it
      // would write unreferenced bytes (GC debt) with no aggregate-cap coverage.
      throw new DeployError(
        "UPLOAD_UNEXPECTED_BLOB",
        `blob ${hash} is not referenced by this upload's manifest`,
      );
    }
    if (bytes.byteLength !== expected.size) {
      throw new DeployError(
        "BLOB_HASH_MISMATCH",
        `staged size ${bytes.byteLength} != declared ${expected.size} for ${hash}`,
      );
    }
    // Warn (don't block) if a text blob appears to embed a canvas API key (§12.1.2 —
    // keys are server-side only, never in canvas files). Mirrors the engine's deploy-
    // time scan so the staged-upload channel surfaces the same lint (review
    // server-canvas-11). The deploy engine emits this in the deploy result's warnings;
    // the staging channel has no per-blob warning surface, so it logs instead.
    if (isTextContentType(expected.mime) && looksLikeApiKey(decodeText(bytes))) {
      deps.log?.warn(
        { canvasId: session.canvasId, hash },
        "staged file may contain a canvas API key — remove it before deploying",
      );
    }
    await putBlobIfAbsent(session.canvasId, hash, bytes);
    const staged = new Set((session.stagedHashes as string[]) ?? []);
    staged.add(hash);
    session.stagedHashes = [...staged] as never;
    await deps.uploadSessions.setStaged(session.id, [...staged]);
  }

  return {
    /**
     * Open an upload session. Records the canonical manifest (server-authoritative
     * mime; paths normalized + zip-slip rejected here so the staging hot path is
     * pure-hash) BEFORE any blob is staged — so the blob-GC live set (U7) always
     * covers a staged blob's hash. Returns the missing hashes the caller must
     * upload (content-addressed skip-unchanged).
     */
    async begin(
      canvas: Canvas,
      actorId: string,
      input: ManifestInput[],
      coordination?: CoordinationInput,
    ): Promise<BeginResult> {
      if (!Array.isArray(input) || input.length === 0) {
        throw new DeployError("INVALID_MANIFEST", "manifest is empty");
      }
      const manifest: Manifest = {};
      for (const e of input) {
        const path = normalizeEntryPath(e.path); // throws on zip-slip; null = dotfile/dir
        if (path === null) continue;
        if (typeof e.hash !== "string" || !/^[0-9a-f]{64}$/.test(e.hash)) {
          throw new DeployError("INVALID_MANIFEST", `bad hash for ${e.path}`, e.path);
        }
        if (typeof e.size !== "number" || e.size < 0) {
          throw new DeployError("INVALID_MANIFEST", `bad size for ${e.path}`, e.path);
        }
        manifest[path] = { size: e.size, hash: e.hash, mime: mimeFor(path).contentType };
      }
      if (Object.keys(manifest).length === 0) {
        throw new DeployError("INVALID_MANIFEST", "manifest has no deployable files");
      }

      // Same content, same size: two entries sharing a hash but disagreeing on size
      // would let the unchecked one lie its way into the version manifest (stageOne
      // validates staged bytes against only the FIRST entry with that hash), skewing
      // totalBytes and the aggregate cap.
      const sizeByHash = new Map<string, number>();
      for (const [path, e] of Object.entries(manifest)) {
        const prior = sizeByHash.get(e.hash);
        if (prior !== undefined && prior !== e.size) {
          throw new DeployError(
            "INVALID_MANIFEST",
            `entries sharing hash ${e.hash} declare different sizes`,
            path,
          );
        }
        sizeByHash.set(e.hash, e.size);
      }

      // Fail fast on the declared manifest: reject oversized files / total / count
      // up front (stageOne re-checks actual bytes, and finalize re-checks the sum,
      // so a lying declared size can't slip the cap — this is just early rejection).
      let declaredBytes = 0;
      for (const e of Object.values(manifest)) {
        if (e.size > LIMITS.maxFileBytes) {
          throw new DeployError("FILE_TOO_LARGE", `a file exceeds ${LIMITS.maxFileBytes} bytes`);
        }
        declaredBytes += e.size;
      }
      if (Object.keys(manifest).length > LIMITS.maxFiles) {
        throw new DeployError("TOO_MANY_FILES", "manifest exceeds 2000 files");
      }
      if (declaredBytes > LIMITS.maxCanvasBytes) {
        throw new DeployError("CANVAS_TOO_LARGE", "manifest exceeds 100 MB total");
      }

      // Content-addressed diff: only request hashes not already in this canvas's
      // blob store (one list + set-diff, cheaper than N× exists).
      const present = new Set(
        (await deps.storage.list(canvasBlobPrefix(canvas.id))).map((k) =>
          hashFromBlobKey(canvas.id, k),
        ),
      );
      const wanted = new Set(Object.values(manifest).map((m) => m.hash));
      const missingHashes = [...wanted].filter((h) => !present.has(h));

      // Deployment coordination (KTD11 / R12): validate the fields and answer the cheap
      // cases before a session exists — a live release needs no upload at all, and a
      // token that is already stale needs no staging. Captured values ride on the session
      // so finalize enforces them at activation (R11).
      const coord = normalizeCoordination(coordination);
      const early = await deps.engine.precheck(canvas, coord);
      if (early) {
        return {
          uploadId: "",
          missingHashes: [],
          alreadyCurrent: deps.engine.toResult(canvas, early),
        };
      }

      const uploadId = generateUploadId();
      await deps.uploadSessions.create({
        canvasId: canvas.id,
        actorId,
        handleHash: hashUploadId(uploadId),
        manifest,
        stagedHashes: [],
        expiresAt: now() + UPLOAD_TTL_MS,
        releaseId: coord.releaseId ?? null,
        expectedPublicationToken: coord.expectedPublicationToken ?? null,
      });
      return { uploadId, missingHashes };
    },

    /** Stage a single blob (the Deploy-API per-blob PUT channel). */
    async stageBlob(
      uploadId: string,
      callerId: string,
      canvasId: string,
      hash: string,
      bytes: Uint8Array,
    ): Promise<void> {
      const session = await requireStageable(hashUploadId(uploadId), callerId, canvasId);
      await stageOne(session, hash, bytes);
    },

    /** Stage a batch of files (the MCP `add_files` channel). */
    async stageFiles(
      uploadId: string,
      callerId: string,
      canvasId: string,
      files: FileInput[],
    ): Promise<void> {
      const session = await requireStageable(hashUploadId(uploadId), callerId, canvasId);
      for (const entry of fromFilesArray(files)) {
        const hash = createHash("sha256").update(entry.bytes).digest("hex");
        await stageOne(session, hash, entry.bytes);
      }
    },

    /**
     * Idempotent single-use finalize. Claims the in-progress lease atomically;
     * re-validates the owner is active and still owns the canvas (block-after-issue);
     * asserts every manifest hash is present and the aggregate caps hold; commits a
     * ready version through the engine's shared tail; only then marks the handle
     * consumed. A transient failure releases the lease so a legitimate retry resumes.
     *
     * Deployment coordination (KTD11): the fields captured at begin merge with any
     * supplied here (a finalize token replaces the captured one; a finalize release must
     * match), the KTD4 pre-check runs BEFORE the claim so the common stale-token case
     * costs no version number, lease or consume, a conflict raised by the atomic
     * activation un-consumes the handle so the caller can finalize again after
     * reassessing, and a repeated finalize of a consumed session whose release is live
     * answers `already_current` (R17 on the staged path).
     */
    async finalize(
      uploadId: string,
      callerId: string,
      canvasId: string,
      coordination?: CoordinationInput,
    ): Promise<DeployResult> {
      const handleHash = hashUploadId(uploadId);
      const supplied = normalizeCoordination(coordination);

      // Binding + liveness pre-check before claiming (clear errors for the common cases).
      const existing = await requireBound(handleHash, callerId, canvasId);
      if (existing.consumedAt) {
        if (existing.releaseId) {
          const c = await deps.engine.classifyRelease(canvasId, existing.releaseId);
          if (c.kind === "already_current") {
            return deps.engine.toResult(c.canvas, alreadyCurrentOutcome(c));
          }
        }
        throw new DeployError("UPLOAD_ALREADY_FINALIZED", "already finalized");
      }
      requireUnexpired(existing);

      // Merge the coordination fields: begin's values are the floor, finalize may
      // refresh the token after reassessing; the release identity is fixed at begin.
      if (
        supplied.releaseId !== undefined &&
        existing.releaseId &&
        supplied.releaseId !== existing.releaseId
      ) {
        throw new DeployError(
          "RELEASE_ID_MISMATCH",
          `finalize releaseId ${supplied.releaseId} differs from the releaseId captured at begin`,
        );
      }
      const coord: Coordination = {};
      const releaseId = supplied.releaseId ?? existing.releaseId ?? undefined;
      if (releaseId !== undefined) coord.releaseId = releaseId;
      const expectedToken =
        supplied.expectedPublicationToken ?? existing.expectedPublicationToken ?? undefined;
      if (expectedToken !== undefined) coord.expectedPublicationToken = expectedToken;

      // The cheap pre-check, before any claim or consume (KTD11).
      const canvasRow = await deps.canvases.findById(canvasId);
      if (!canvasRow) throw new DeployError("UPLOAD_HANDLE_INVALID", "no such upload session");
      const early = await deps.engine.precheck(canvasRow, coord);
      if (early) return deps.engine.toResult(canvasRow, early);

      const claimed = await deps.uploadSessions.claimForFinalize(
        handleHash,
        now() - FINALIZE_LEASE_MS,
      );
      if (!claimed) {
        const s = await deps.uploadSessions.findByHandleHash(handleHash);
        if (s?.consumedAt) throw new DeployError("UPLOAD_ALREADY_FINALIZED", "already finalized");
        throw new DeployError("UPLOAD_IN_PROGRESS", "another finalize is in progress");
      }

      try {
        // Re-validate identity ON USE, not just at issue (block-after-issue, §12.0).
        const user = await deps.users.findById(claimed.actorId);
        if (!user || user.isBlocked) {
          throw new DeployError("UPLOAD_HANDLE_INVALID", "session actor is not active");
        }
        // Role re-check through the shared resolver (editor-roles plan, KTD1): the
        // session's actor must STILL be an owner or editor of the canvas at finalize
        // time, with org membership re-resolved live (KTD2) — a demoted editor or a
        // departed member cannot finish a deploy they began. 404-equivalent, no
        // existence leak; a non-owner admin is not a bypass.
        const orgIds = deps.orgMembership ? await deps.orgMembership(user) : new Set<string>();
        const grant = await resolveManagementGrant(
          await deps.canvases.findById(canvasId),
          memberPrincipal(user, orgIds),
          { canvases: deps.canvases, tenancyActive: !!deps.config.org.name },
        );
        if (!grant) {
          throw new DeployError("UPLOAD_HANDLE_INVALID", "canvas not available to this actor");
        }
        const canvas = grant.canvas;

        const manifest = (claimed.manifest as Manifest | null) ?? {};
        const paths = Object.keys(manifest);
        if (paths.length === 0) throw new DeployError("EMPTY_DEPLOY", "no deployable files");

        const fileCount = paths.length;
        if (fileCount > LIMITS.maxFiles) {
          throw new DeployError("TOO_MANY_FILES", "upload exceeds 2000 files");
        }
        let totalBytes = 0;
        for (const entry of Object.values(manifest)) totalBytes += entry.size;
        if (totalBytes > LIMITS.maxCanvasBytes) {
          throw new DeployError("CANVAS_TOO_LARGE", "upload exceeds 100 MB total");
        }

        // Assert every referenced blob is present (trust existence for skip-unchanged
        // blobs — matches putBlobIfAbsent semantics; content re-verification is out
        // of scope, plan 003 KTD4/A4).
        const uniqueHashes = new Set(Object.values(manifest).map((m) => m.hash));
        for (const hash of uniqueHashes) {
          if (!(await deps.storage.exists(blobKey(canvasId, hash)))) {
            throw new DeployError("UPLOAD_MISSING_BLOB", `blob ${hash} was not staged`);
          }
        }

        const warnings: string[] = [];
        for (const p of paths) {
          if (mimeFor(p).downgraded) warnings.push(`${p} will be served as text/plain`);
        }
        if (!manifest["index.html"] && !soleHtmlEntry(manifest)) {
          warnings.push(
            "No index.html — visitors to the canvas root will get a 404. Name your entry file index.html.",
          );
        }

        const version = await deps.engine.createVersionWithRetry(
          canvasId,
          claimed.actorId,
          "upload",
          coord.releaseId,
        );
        // Mark the handle terminal BEFORE the commit so a transient failure in
        // commitReadyVersion (or markConsumed itself succeeding then the commit
        // throwing) can never let a retry re-claim the session and create a second
        // identical version (double-publish, review server-canvas-1). The blobs are
        // already staged, so a failed commit after this point requires a fresh
        // begin()/stage/finalize cycle — acceptable, and never duplicates a version.
        await deps.uploadSessions.markConsumed(claimed.id);
        const committed = await deps.engine.commitReadyVersion(
          canvas,
          version,
          manifest,
          fileCount,
          totalBytes,
          { coordination: coord },
        );
        return deps.engine.toResult(canvas, committed, warnings);
      } catch (err) {
        if (err instanceof PublicationConflictError) {
          // The pointer never moved and the candidate is gone (KTD3): reopen the handle
          // so the caller can reassess and finalize again without re-staging (R16).
          // Fenced on the lease this attempt claimed: a finalize that outlived
          // FINALIZE_LEASE_MS must never reopen a handle a newer attempt consumed.
          await deps.uploadSessions
            .unconsume(claimed.id, claimed.finalizingAt)
            .then((reopened) => {
              if (!reopened) {
                deps.log?.warn(
                  { sessionId: claimed.id },
                  "unconsume skipped: the finalize lease was re-claimed by a newer attempt",
                );
              }
            })
            .catch((e) =>
              deps.log?.warn({ err: e, sessionId: claimed.id }, "unconsume after conflict failed"),
            );
          throw err;
        }
        // Release the lease so a legitimate retry (a client that still needs to
        // upload a missing blob, or a pre-markConsumed failure) can re-claim. Once
        // the handle is marked consumed (just before commitReadyVersion), a retry
        // is intentionally refused with UPLOAD_ALREADY_FINALIZED — a fresh begin()
        // is required — so a transient commit failure can't double-publish.
        await deps.uploadSessions
          .clearFinalizing(claimed.id)
          .catch((clearErr) =>
            deps.log?.warn(
              { err: clearErr, sessionId: claimed.id },
              "clearFinalizing failed; session lease will self-heal after FINALIZE_LEASE_MS",
            ),
          );
        throw err;
      }
    },
  };
}

export type UploadService = ReturnType<typeof uploadService>;

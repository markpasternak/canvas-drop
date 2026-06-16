import { createHash } from "node:crypto";
import type { Config } from "@canvas-drop/shared";
import type { Canvas, Manifest, UploadSession } from "@canvas-drop/shared/db";
import { soleHtmlEntry } from "../canvas/manifest.js";
import { mimeFor } from "../canvas/mime.js";
import { blobKey, canvasBlobPrefix, hashFromBlobKey } from "../canvas/storage-keys.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { UploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { DeployEngine, DeployResult } from "../deploy/engine.js";
import { DeployError, LIMITS } from "../deploy/errors.js";
import { type FileInput, fromFilesArray } from "../deploy/ingest.js";
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
}

export interface UploadServiceDeps {
  config: Config;
  canvases: CanvasesRepository;
  users: UsersRepository;
  uploadSessions: UploadSessionsRepository;
  storage: StorageDriver;
  engine: DeployEngine;
  log?: Logger;
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
 * gated front-ends (MCP `requireOwned` / Deploy-API `authCanvas`); the service
 * re-checks them on every staging op and again at finalize (block-after-issue).
 */
export function uploadService(deps: UploadServiceDeps) {
  const now = deps.now ?? Date.now;

  /** Resolve a session by plaintext uploadId, enforcing owner + canvas binding + liveness. */
  async function requireStageable(
    handleHash: string,
    callerId: string,
    canvasId: string,
  ): Promise<UploadSession> {
    const s = await deps.uploadSessions.findByHandleHash(handleHash);
    // One opaque code for unknown / wrong-owner / wrong-canvas — no existence leak.
    if (!s || s.ownerId !== callerId || s.canvasId !== canvasId) {
      throw new DeployError("UPLOAD_HANDLE_INVALID", "no such upload session");
    }
    if (s.consumedAt) throw new DeployError("UPLOAD_ALREADY_FINALIZED", "already finalized");
    if (s.expiresAt <= now()) throw new DeployError("UPLOAD_EXPIRED", "upload session expired");
    return s;
  }

  async function putBlobIfAbsent(canvasId: string, hash: string, bytes: Uint8Array): Promise<void> {
    const key = blobKey(canvasId, hash);
    if (await deps.storage.exists(key)) return;
    await deps.storage.put(key, bytes);
  }

  /** Stage one blob: verify its hash matches its bytes, write it, record it staged. */
  async function stageOne(session: UploadSession, hash: string, bytes: Uint8Array): Promise<void> {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== hash) {
      throw new DeployError("BLOB_HASH_MISMATCH", `blob bytes do not match hash ${hash}`);
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
    async begin(canvas: Canvas, ownerId: string, input: ManifestInput[]): Promise<BeginResult> {
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

      // Content-addressed diff: only request hashes not already in this canvas's
      // blob store (one list + set-diff, cheaper than N× exists).
      const present = new Set(
        (await deps.storage.list(canvasBlobPrefix(canvas.id))).map((k) =>
          hashFromBlobKey(canvas.id, k),
        ),
      );
      const wanted = new Set(Object.values(manifest).map((m) => m.hash));
      const missingHashes = [...wanted].filter((h) => !present.has(h));

      const uploadId = generateUploadId();
      await deps.uploadSessions.create({
        canvasId: canvas.id,
        ownerId,
        handleHash: hashUploadId(uploadId),
        manifest,
        stagedHashes: [],
        expiresAt: now() + UPLOAD_TTL_MS,
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
     */
    async finalize(uploadId: string, callerId: string, canvasId: string): Promise<DeployResult> {
      const handleHash = hashUploadId(uploadId);
      // Liveness/owner pre-check before claiming (clear errors for the common cases).
      await requireStageable(handleHash, callerId, canvasId);

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
        const user = await deps.users.findById(claimed.ownerId);
        if (!user || user.isBlocked) {
          throw new DeployError("UPLOAD_HANDLE_INVALID", "session owner is not active");
        }
        // Owner re-check through the owner-only seam: 404-equivalent, no existence
        // leak; a non-owner admin is not a bypass.
        const canvas = await deps.canvases.findById(canvasId);
        if (!canvas || canvas.status === "deleted" || canvas.ownerId !== claimed.ownerId) {
          throw new DeployError("UPLOAD_HANDLE_INVALID", "canvas not available to this owner");
        }

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
          claimed.ownerId,
          "upload",
        );
        await deps.engine.commitReadyVersion(canvas, version, manifest, fileCount, totalBytes);
        await deps.uploadSessions.markConsumed(claimed.id);

        return {
          url: canvasUrl(deps.config, canvas.slug),
          version: version.number,
          fileCount,
          totalBytes,
          warnings,
        };
      } catch (err) {
        // Release the lease so a legitimate retry (transient commit failure, or a
        // client that still needs to upload a missing blob) can re-claim. Only a
        // SUCCESSFUL finalize marks the handle consumed (terminal).
        await deps.uploadSessions.clearFinalizing(claimed.id).catch(() => {});
        throw err;
      }
    },
  };
}

export type UploadService = ReturnType<typeof uploadService>;

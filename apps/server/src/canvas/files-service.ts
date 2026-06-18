import type { FileRow } from "@canvas-drop/shared/db";
import { v7 as uuidv7 } from "uuid";
import type { QuotaResolver } from "../admin/settings-service.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";

/** Files primitive limits (§6.5.5). Admin-tunable defaults (M7). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB/file
export const MAX_CANVAS_BYTES = 1024 * 1024 * 1024; // 1 GB/canvas

export class FileTooLargeError extends Error {
  readonly code = "FILE_TOO_LARGE" as const;
  constructor() {
    super(`File exceeds the ${MAX_FILE_BYTES}-byte per-file limit`);
    this.name = "FileTooLargeError";
  }
}

export class FilesQuotaError extends Error {
  readonly code = "QUOTA_EXCEEDED" as const;
  constructor() {
    super(`Upload would exceed the ${MAX_CANVAS_BYTES}-byte per-canvas quota`);
    this.name = "FilesQuotaError";
  }
}

export interface CreateFileInput {
  canvasId: string;
  filename: string;
  mime: string;
  bytes: Uint8Array;
  userId: string;
}

/** The per-canvas storage key for a file blob. */
export function fileStorageKey(canvasId: string, id: string): string {
  return `files/${canvasId}/${id}`;
}

/**
 * Files service (§6.5, plan 007 / M6). Orchestrates the storage driver + metadata
 * repo: enforces per-file and per-canvas limits, writes the blob then the row, and
 * cleans up the orphan blob if the row insert fails. Quota is best-effort
 * (check-then-write; KTD-4) — acceptable on the trusted-org model.
 */
export function filesService(deps: {
  files: FilesRepository;
  storage: StorageDriver;
  /** Admin-tunable quota resolver (M7). Absent → the hard constants above. */
  quota?: QuotaResolver;
  /** Optional logger so best-effort blob cleanups that fail are at least observable. */
  log?: Logger;
}) {
  const { files, storage, quota, log } = deps;

  return {
    async create(input: CreateFileInput): Promise<FileRow> {
      const fileMax = quota ? await quota("files.bytes.file", MAX_FILE_BYTES) : MAX_FILE_BYTES;
      const canvasMax = quota
        ? await quota("files.bytes.canvas", MAX_CANVAS_BYTES)
        : MAX_CANVAS_BYTES;
      if (input.bytes.byteLength > fileMax) throw new FileTooLargeError();
      const used = await files.totalBytes(input.canvasId);
      if (used + input.bytes.byteLength > canvasMax) throw new FilesQuotaError();

      const id = uuidv7();
      const storageKey = fileStorageKey(input.canvasId, id);
      await storage.put(storageKey, input.bytes, { contentType: input.mime });
      try {
        return await files.insert({
          id,
          canvasId: input.canvasId,
          filename: input.filename,
          mime: input.mime,
          sizeBytes: input.bytes.byteLength,
          storageKey,
          uploadedBy: input.userId,
        });
      } catch (err) {
        // Row insert failed after the blob landed — clean up the orphan blob. The
        // cleanup is best-effort but not silent: a failed delete leaves a blob with
        // no row to find it by, so log it for observability (review server-canvas-6).
        await storage
          .delete(storageKey)
          .catch((cleanupErr) =>
            log?.warn(
              { err: cleanupErr, canvasId: input.canvasId, storageKey },
              "orphan blob cleanup failed after files row insert error",
            ),
          );
        throw err;
      }
    },

    list(canvasId: string): Promise<FileRow[]> {
      return files.list(canvasId);
    },

    /** Remove the file (row + blob). Returns false if it didn't exist for this canvas. */
    async delete(canvasId: string, id: string): Promise<boolean> {
      const row = await files.remove(canvasId, id);
      if (!row) return false;
      // The DB row is authoritative, so a failed blob delete is best-effort — but
      // it must not be silent: the orphaned blob no longer maps to any row, so the
      // GC sweep can't find it by normal means. Log it so it's observable.
      await storage
        .delete(row.storageKey)
        .catch((err) =>
          log?.warn(
            { err, canvasId, storageKey: row.storageKey },
            "blob delete failed after file row removal — orphaned blob",
          ),
        );
      return true;
    },

    /** The row + bytes for serving, or null if the id isn't this canvas's. */
    async content(
      canvasId: string,
      id: string,
    ): Promise<{ row: FileRow; bytes: Uint8Array } | null> {
      const row = await files.findById(canvasId, id);
      if (!row) return null;
      const bytes = await storage.get(row.storageKey);
      if (!bytes) return null;
      return { row, bytes };
    },
  };
}

export type FilesService = ReturnType<typeof filesService>;

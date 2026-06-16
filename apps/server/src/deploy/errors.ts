/**
 * Stable, machine-readable deploy error codes (§9.5.4) — agents repair from
 * these, so they are part of the API contract. Don't rename without versioning.
 */
export type DeployErrorCode =
  | "EMPTY_DEPLOY"
  | "TOO_MANY_FILES"
  | "FILE_TOO_LARGE"
  | "CANVAS_TOO_LARGE"
  | "ZIP_SLIP_REJECTED"
  | "ZIP_BOMB_REJECTED"
  | "INVALID_ZIP"
  | "INVALID_PATH"
  // A create/rename targeted a path that already exists in the draft, which would
  // silently overwrite (and destroy) the file already there. The editor refuses it
  // so the operation is non-destructive — pick a different path or replace the file.
  | "PATH_EXISTS"
  // Rollback target was pruned between selection and the pointer swap (a
  // concurrent deploy's prune won the race); the client should refresh + retry.
  | "VERSION_UNAVAILABLE"
  // --- Two-channel upload flow (plan 003) ---
  // Unknown / wrong-owner / wrong-canvas upload handle. Deliberately one code for
  // all three so a non-owner can't distinguish "no such handle" from "not yours"
  // (no existence leak, §12.0). Maps to 404.
  | "UPLOAD_HANDLE_INVALID"
  // The upload session passed its TTL before finalize.
  | "UPLOAD_EXPIRED"
  // The handle was already finalized (terminal); a fresh `begin` is required.
  | "UPLOAD_ALREADY_FINALIZED"
  // Another finalize attempt currently holds the in-progress lease; retry shortly.
  | "UPLOAD_IN_PROGRESS"
  // Finalize referenced a manifest hash whose blob was never staged / is absent.
  | "UPLOAD_MISSING_BLOB"
  // A staged blob's sha256 did not match the hash it was uploaded under.
  | "BLOB_HASH_MISMATCH"
  // A `files[]` entry declared an encoding other than utf8/base64.
  | "INVALID_ENCODING"
  // The begin manifest was empty or malformed.
  | "INVALID_MANIFEST";

export class DeployError extends Error {
  constructor(
    public readonly code: DeployErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "DeployError";
  }
}

/** Deploy limits (§6.1.18). */
export const LIMITS = {
  maxCanvasBytes: 100 * 1024 * 1024, // 100 MB total
  maxFileBytes: 25 * 1024 * 1024, // 25 MB / file
  maxFiles: 2000,
} as const;

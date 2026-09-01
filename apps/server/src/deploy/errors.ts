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
  | "DRAFT_CONFLICT"
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
  // A staged blob's hash is not referenced by the session's begin-manifest, so it
  // could never be finalized — rejecting it keeps unreferenced bytes out of
  // storage and keeps the aggregate size cap authoritative at stage time.
  | "UPLOAD_UNEXPECTED_BLOB"
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

/**
 * A stale draft-file save (editor-roles plan, KTD8/R17): the client's view of `path` is
 * behind the draft. Carries the entry's CURRENT hash and last writer so a retry is one
 * call — HTTP maps it to 409 `{ code: "DRAFT_CONFLICT", path, currentHash, updatedBy,
 * updatedByName, updatedAt }`; MCP to the `DRAFT_CONFLICT:` prefix with the same fields.
 */
export class DraftConflictError extends DeployError {
  constructor(
    public readonly conflict: {
      path: string;
      /** The entry's current hash, or `none` when the path is absent from the draft. */
      currentHash: string;
      updatedBy: string | null;
      updatedByName: string | null;
      updatedAt: number | null;
    },
  ) {
    super("DRAFT_CONFLICT", describeConflict(conflict), conflict.path);
    this.name = "DraftConflictError";
  }
}

function describeConflict(c: DraftConflictError["conflict"]): string {
  const who = c.updatedByName || c.updatedBy || "someone else";
  const when = c.updatedAt ? new Date(c.updatedAt).toISOString() : "an unknown time";
  return c.currentHash === "none"
    ? `${c.path} was removed from the draft since you loaded it; reload the draft before saving.`
    : `${c.path} was changed by ${who} at ${when}; reload it before saving again.`;
}

/** Deploy limits (§6.1.18). */
export const LIMITS = {
  maxCanvasBytes: 100 * 1024 * 1024, // 100 MB total
  maxFileBytes: 25 * 1024 * 1024, // 25 MB / file
  maxFiles: 2000,
} as const;

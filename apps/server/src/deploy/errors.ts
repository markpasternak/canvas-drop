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
  | "VERSION_UNAVAILABLE";

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

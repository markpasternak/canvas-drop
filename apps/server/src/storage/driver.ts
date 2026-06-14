/**
 * Storage abstraction (BUILD_BRIEF.md D17, §6.5.7). One interface, two drivers
 * (local disk / S3-compatible). This unit proves the interface with generic
 * blobs; canvas-asset semantics (MIME, versioning, caching) arrive in area C.
 */
export interface PutOptions {
  contentType?: string;
}

export interface StorageDriver {
  /** Write bytes at `key`, creating intermediate structure as needed. */
  put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<void>;
  /** Read bytes at `key`, or `null` if it does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Remove `key`; a no-op if it does not exist. */
  delete(key: string): Promise<void>;
  /**
   * Remove many keys, batching where the backend supports it (S3 deletes up to
   * 1000 per request; local/memory loop). A no-op on an empty list. Missing keys
   * are ignored, matching {@link delete}.
   */
  deleteMany(keys: string[]): Promise<void>;
  /**
   * Copy the object at `srcKey` to `dstKey`, creating intermediate structure as
   * needed and overwriting any existing object at `dstKey`. Throws a
   * {@link StorageError} with code `not_found` when `srcKey` does not exist — a
   * manifest referencing an absent blob is corruption, not something to skip.
   * S3 does this server-side (CopyObject, no download); local copies the file;
   * mem copies the bytes. Used by the canvas clone path to duplicate blobs into a
   * new per-canvas namespace (plan 002).
   */
  copy(srcKey: string, dstKey: string): Promise<void>;
  /** Whether an object exists at `key`. */
  exists(key: string): Promise<boolean>;
  /** Keys beginning with `prefix`. */
  list(prefix: string): Promise<string[]>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

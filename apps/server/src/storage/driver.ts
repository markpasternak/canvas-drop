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

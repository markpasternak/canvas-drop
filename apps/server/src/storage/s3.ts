import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { type PutOptions, type StorageDriver, StorageError } from "./driver.js";

/** S3 DeleteObjects accepts at most 1000 keys per request. */
const DELETE_BATCH = 1000;

/**
 * S3-compatible storage driver — AWS S3, MinIO, Cloudflare R2, or any
 * S3-compatible endpoint (endpoint-configurable). The {@link S3Client} is
 * injected so the factory owns endpoint/credential config and tests can supply
 * an in-memory fake.
 */
export class S3Driver implements StorageDriver {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: opts?.contentType,
      }),
    );
  }

  async copy(srcKey: string, dstKey: string): Promise<void> {
    // CopySource is `bucket/key`; URL-encode each key segment (preserving the
    // path separators) so any non-ASCII/special chars in a key round-trip.
    const copySource = `${this.bucket}/${srcKey.split("/").map(encodeURIComponent).join("/")}`;
    try {
      await this.client.send(
        new CopyObjectCommand({ Bucket: this.bucket, Key: dstKey, CopySource: copySource }),
      );
    } catch (err) {
      if (isMissing(err)) {
        throw new StorageError(`source key does not exist: ${srcKey}`, "not_found");
      }
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return await res.Body.transformToByteArray();
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const chunk = keys.slice(i, i + DELETE_BATCH);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      // S3 reports per-key failures in the body rather than throwing; surface
      // them so the caller (purge) treats the canvas as not fully reclaimed.
      if (res.Errors && res.Errors.length > 0) {
        const first = res.Errors[0];
        throw new StorageError(
          `failed to delete ${res.Errors.length} object(s); first: ${first?.Key} (${first?.Code})`,
          "delete_failed",
        );
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }
}

/** S3 "not found" surfaces as NoSuchKey (GET) or NotFound / 404 (HEAD). */
function isMissing(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404;
}

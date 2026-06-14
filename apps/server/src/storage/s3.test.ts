import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { storageContract } from "./contract.js";
import { StorageError } from "./driver.js";
import { S3Driver } from "./s3.js";

/**
 * In-memory S3 fake exercising the real {@link S3Driver} logic without a live
 * backend. CI runs the same driver against MinIO (U12); this gives fast,
 * deterministic local coverage of the command mapping.
 */
function fakeS3Client(): S3Client {
  const store = new Map<string, Uint8Array>();
  const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    const key = cmd.input.Key as string | undefined;
    switch (name) {
      case "PutObjectCommand":
        store.set(key as string, cmd.input.Body as Uint8Array);
        return {};
      case "CopyObjectCommand": {
        // CopySource is `bucket/enc/seg/.../key`; drop the bucket, decode each segment.
        const parts = (cmd.input.CopySource as string).split("/");
        parts.shift();
        const srcKey = parts.map(decodeURIComponent).join("/");
        const bytes = store.get(srcKey);
        if (!bytes) {
          throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        }
        store.set(key as string, bytes);
        return {};
      }
      case "GetObjectCommand": {
        const bytes = store.get(key as string);
        if (!bytes) {
          throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        }
        return { Body: { transformToByteArray: async () => bytes } };
      }
      case "HeadObjectCommand":
        if (!store.has(key as string)) {
          throw Object.assign(new Error("NotFound"), { name: "NotFound" });
        }
        return {};
      case "DeleteObjectCommand":
        store.delete(key as string);
        return {};
      case "DeleteObjectsCommand": {
        const del = cmd.input.Delete as { Objects: { Key: string }[] };
        for (const o of del.Objects) store.delete(o.Key);
        return { Deleted: del.Objects, Errors: [] };
      }
      case "ListObjectsV2Command": {
        const prefix = (cmd.input.Prefix as string) ?? "";
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
      }
      default:
        throw new Error(`unhandled command: ${name}`);
    }
  };
  return { send } as unknown as S3Client;
}

describe("S3Driver (in-memory fake)", () => {
  storageContract(() => new S3Driver(fakeS3Client(), "test-bucket"));
});

describe("S3Driver deleteMany error handling", () => {
  it("rejects with StorageError when S3 returns per-key Errors in the response", async () => {
    const errorClient: S3Client = {
      send: async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === "DeleteObjectsCommand") {
          return {
            Deleted: [],
            Errors: [{ Key: "k/1", Code: "AccessDenied", Message: "Access Denied" }],
          };
        }
        return {};
      },
    } as unknown as S3Client;

    const driver = new S3Driver(errorClient, "test-bucket");
    await expect(driver.deleteMany(["k/1"])).rejects.toBeInstanceOf(StorageError);
    await expect(driver.deleteMany(["k/1"])).rejects.toMatchObject({
      code: "delete_failed",
      message: expect.stringContaining("k/1"),
    });
    await expect(driver.deleteMany(["k/1"])).rejects.toMatchObject({
      message: expect.stringContaining("AccessDenied"),
    });
  });
});

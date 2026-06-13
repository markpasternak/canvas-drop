import type { S3Client } from "@aws-sdk/client-s3";
import { describe } from "vitest";
import { storageContract } from "./contract.js";
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

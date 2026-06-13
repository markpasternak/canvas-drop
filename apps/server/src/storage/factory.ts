import { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "@canvas-drop/shared";
import type { StorageDriver } from "./driver.js";
import { LocalDriver } from "./local.js";
import { S3Driver } from "./s3.js";

/** Construct the configured storage driver (BUILD_BRIEF.md D17). */
export function makeStorage(config: Config): StorageDriver {
  if (config.storage.driver === "local") {
    return new LocalDriver(config.storage.path);
  }

  const s = config.storage;
  const client = new S3Client({
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
  });
  return new S3Driver(client, s.bucket);
}

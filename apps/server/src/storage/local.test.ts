import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storageContract } from "./contract.js";
import { StorageError } from "./driver.js";
import { LocalDriver } from "./local.js";

describe("LocalDriver", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-storage-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  storageContract(() => new LocalDriver(dir));

  it("rejects keys that escape the storage root", async () => {
    const d = new LocalDriver(dir);
    await expect(d.put("../escape.txt", new Uint8Array([1]))).rejects.toBeInstanceOf(StorageError);
    await expect(d.get("../../etc/passwd")).rejects.toBeInstanceOf(StorageError);
    await expect(d.put("/etc/passwd", new Uint8Array([1]))).rejects.toBeInstanceOf(StorageError);
  });

  it("allows nested keys within the root", async () => {
    const d = new LocalDriver(dir);
    await d.put("deep/nested/path/file.bin", new Uint8Array([9]));
    expect(await d.exists("deep/nested/path/file.bin")).toBe(true);
  });
});

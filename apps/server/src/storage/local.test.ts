import { mkdtemp, readdir, rm } from "node:fs/promises";
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

  it("prunes now-empty parent dirs on delete, but keeps dirs with siblings", async () => {
    const d = new LocalDriver(dir);
    await d.put("versions/v1/index.html", new Uint8Array([1]));
    await d.put("versions/v1/assets/app.js", new Uint8Array([2]));

    // Deleting one of two files leaves the still-occupied dirs in place.
    await d.delete("versions/v1/assets/app.js");
    expect(await readdir(dir)).toContain("versions");
    expect(await readdir(join(dir, "versions/v1"))).toEqual(["index.html"]);

    // Deleting the last file collapses the whole empty chain up to the root.
    await d.delete("versions/v1/index.html");
    expect(await readdir(dir)).toEqual([]);
  });
});

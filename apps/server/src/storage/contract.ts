import { expect, it } from "vitest";
import type { StorageDriver } from "./driver.js";

/**
 * Shared behavioural contract every {@link StorageDriver} must satisfy. Invoked
 * from both local.test.ts and s3.test.ts so the two drivers are held to the
 * same bar. `makeDriver` returns a fresh, empty driver per call.
 */
export function storageContract(makeDriver: () => StorageDriver | Promise<StorageDriver>) {
  it("round-trips bytes through put/get", async () => {
    const d = await makeDriver();
    await d.put("a/b.txt", new TextEncoder().encode("hello canvas"));
    const got = await d.get("a/b.txt");
    expect(got).not.toBeNull();
    expect(Buffer.from(got as Uint8Array).toString()).toBe("hello canvas");
  });

  it("returns null for a missing key", async () => {
    const d = await makeDriver();
    expect(await d.get("missing")).toBeNull();
  });

  it("reflects existence and deletion", async () => {
    const d = await makeDriver();
    await d.put("x.txt", new Uint8Array([1, 2, 3]));
    expect(await d.exists("x.txt")).toBe(true);
    await d.delete("x.txt");
    expect(await d.exists("x.txt")).toBe(false);
    expect(await d.get("x.txt")).toBeNull();
  });

  it("deleting a missing key is a no-op", async () => {
    const d = await makeDriver();
    await expect(d.delete("never-existed")).resolves.toBeUndefined();
  });

  it("deleteMany removes the listed keys, ignores missing ones, and leaves the rest", async () => {
    const d = await makeDriver();
    await d.put("k/1", new Uint8Array([1]));
    await d.put("k/2", new Uint8Array([2]));
    await d.put("k/3", new Uint8Array([3]));

    await expect(d.deleteMany([])).resolves.toBeUndefined(); // empty is a no-op
    await d.deleteMany(["k/1", "k/2", "k/missing"]);

    expect(await d.exists("k/1")).toBe(false);
    expect(await d.exists("k/2")).toBe(false);
    expect(await d.exists("k/3")).toBe(true);
  });

  it("copy duplicates bytes into a nested key and leaves the source in place", async () => {
    const d = await makeDriver();
    await d.put("src/a.txt", new TextEncoder().encode("payload"));
    await d.copy("src/a.txt", "nested/dst/b.txt");
    const got = await d.get("nested/dst/b.txt");
    expect(Buffer.from(got as Uint8Array).toString()).toBe("payload");
    // copy, not move — the source still exists
    expect(await d.exists("src/a.txt")).toBe(true);
  });

  it("copy overwrites an existing destination", async () => {
    const d = await makeDriver();
    await d.put("s", new Uint8Array([1]));
    await d.put("d", new Uint8Array([9, 9]));
    await d.copy("s", "d");
    expect(Array.from((await d.get("d")) as Uint8Array)).toEqual([1]);
  });

  it("copy of a missing source rejects and creates no destination object", async () => {
    const d = await makeDriver();
    await expect(d.copy("never-existed", "dst")).rejects.toThrow();
    expect(await d.exists("dst")).toBe(false);
  });

  it("lists keys by prefix", async () => {
    const d = await makeDriver();
    await d.put("p/1.txt", new Uint8Array([1]));
    await d.put("p/2.txt", new Uint8Array([2]));
    await d.put("other/3.txt", new Uint8Array([3]));
    expect(await d.list("p/")).toEqual(["p/1.txt", "p/2.txt"]);
  });
}

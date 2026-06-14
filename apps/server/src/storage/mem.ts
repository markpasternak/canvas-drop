import { type StorageDriver, StorageError } from "./driver.js";

/**
 * In-memory StorageDriver for tests. `failOnPut` makes the Nth `put` throw — used
 * to exercise the deploy engine's atomicity (a storage failure mid-deploy must
 * leave the live version untouched).
 */
export function memStorage(failOnPut?: number): StorageDriver {
  const store = new Map<string, Uint8Array>();
  let puts = 0;
  return {
    async put(key, bytes) {
      puts++;
      if (failOnPut && puts === failOnPut) throw new Error("storage down");
      store.set(key, bytes);
    },
    async copy(srcKey, dstKey) {
      const bytes = store.get(srcKey);
      if (bytes === undefined) {
        throw new StorageError(`source key does not exist: ${srcKey}`, "not_found");
      }
      // Store an independent copy, matching local (copyFile) and S3 (CopyObject)
      // semantics — never alias the source buffer under the destination key.
      store.set(dstKey, bytes.slice());
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async delete(key) {
      store.delete(key);
    },
    async deleteMany(keys) {
      for (const key of keys) store.delete(key);
    },
    async exists(key) {
      return store.has(key);
    },
    async list(prefix) {
      return [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

import type { Dirent } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type PutOptions, type StorageDriver, StorageError } from "./driver.js";

/**
 * Local filesystem storage driver. Keys map to files under a single root; any
 * key that would escape the root (e.g. `../`, absolute paths) is rejected.
 */
export class LocalDriver implements StorageDriver {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Resolve a key to an absolute path, rejecting anything outside the root. */
  private pathFor(key: string): string {
    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new StorageError(`key escapes storage root: ${key}`, "invalid_key");
    }
    return target;
  }

  async put(key: string, bytes: Uint8Array, _opts?: PutOptions): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  async copy(srcKey: string, dstKey: string): Promise<void> {
    const src = this.pathFor(srcKey);
    const dst = this.pathFor(dstKey);
    await mkdir(dirname(dst), { recursive: true });
    try {
      await copyFile(src, dst);
    } catch (err) {
      if (isNotFound(err)) {
        throw new StorageError(`source key does not exist: ${srcKey}`, "not_found");
      }
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.pathFor(key);
    await rm(target, { force: true });
    // Prune now-empty parent directories up to (never including) the root, so
    // reclaiming a version's files leaves no empty dir skeletons behind. S3 has
    // no directories; this keeps the local driver's on-disk state equivalent.
    // `rmdir` throws ENOTEMPTY on a dir that still holds files — that's the
    // signal to stop walking up.
    let dir = dirname(target);
    while (dir !== this.root && dir.startsWith(this.root + sep)) {
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    // Local disk has no batch primitive; loop through delete so each removal
    // also prunes its now-empty parent dirs.
    for (const key of keys) await this.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for await (const full of this.walk(this.root)) {
      const key = relative(this.root, full).split(sep).join("/");
      if (key.startsWith(prefix)) out.push(key);
    }
    return out.sort();
  }

  private async *walk(dir: string): AsyncGenerator<string> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(full);
      } else {
        yield full;
      }
    }
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

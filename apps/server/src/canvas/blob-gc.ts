import type { Manifest } from "@canvas-drop/shared/db";
import type { DraftsRepository } from "../db/repositories/drafts.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { canvasBlobPrefix, hashFromBlobKey } from "./storage-keys.js";

export interface BlobGcDeps {
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
  log: Logger;
}

/** Collect every content hash referenced by a set of manifests. */
function hashesOf(manifests: Array<Manifest | null | undefined>): Set<string> {
  const hashes = new Set<string>();
  for (const manifest of manifests) {
    if (!manifest) continue;
    for (const entry of Object.values(manifest)) hashes.add(entry.hash);
  }
  return hashes;
}

/**
 * Per-canvas blob mark-sweep (M5, KTD-4 / R8). A blob is *live* iff some surviving
 * `ready` version's manifest **or** the canvas draft references its hash; every
 * other blob under the canvas prefix is unreferenced and reclaimed. This subsumes
 * both pruned-version blobs and draft-churn orphans (a file edited h1→h2 leaves
 * h1 unreferenced) in one sweep.
 *
 * Best-effort and idempotent: logs and swallows storage/DB errors so it never
 * blocks or fails a deploy/publish. Run it AFTER version-row pruning so dropped
 * versions are already out of the live set.
 *
 * Race note: a publish concurrent with the sweep could, in a narrow window,
 * reference a blob the sweep is about to delete. At D13 single-org scale this is
 * accepted: blob puts are idempotent, so a re-publish/re-deploy re-writes any
 * wrongly-swept blob, and serving already 404s a missing asset rather than
 * crashing. (Mirrors the documented prune-vs-rollback / purge-vs-deploy races.)
 */
export async function collectGarbage(deps: BlobGcDeps, canvasId: string): Promise<void> {
  try {
    const versions = await deps.versions.listByCanvas(canvasId);
    const draft = await deps.drafts.getByCanvas(canvasId);
    const live = hashesOf([
      ...versions.filter((v) => v.status === "ready").map((v) => v.manifest as Manifest | null),
      (draft?.manifest as Manifest | null) ?? null,
    ]);

    const prefix = canvasBlobPrefix(canvasId);
    const existing = await deps.storage.list(prefix);
    const garbage = existing.filter((key) => !live.has(hashFromBlobKey(canvasId, key)));
    if (garbage.length === 0) return;

    await deps.storage.deleteMany(garbage);
    deps.log.info({ canvasId, reclaimed: garbage.length, live: live.size }, "blob GC reclaimed");
  } catch (err) {
    deps.log.error({ err, canvasId }, "blob GC failed (live version unaffected)");
  }
}

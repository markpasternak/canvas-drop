import type { Canvas, Manifest } from "@canvas-drop/shared/db";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { DraftsRepository } from "../db/repositories/drafts.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { Logger } from "../log/logger.js";
import type { StorageDriver } from "../storage/driver.js";
import { generateApiKey, hashApiKey } from "./api-key.js";
import { generateUniqueSlug } from "./slug.js";
import { blobKey } from "./storage-keys.js";

export interface CloneServiceDeps {
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
  /** Optional logger so a failed mid-clone rollback (which can leave a half-cloned
   *  canvas active) is observable rather than fully silent (review server-canvas-17). */
  log?: Logger;
}

/**
 * How many blob copies to run concurrently when cloning. Each S3 `CopyObject` is a
 * server-side copy (no bytes transit this process) but still a network round-trip,
 * so copying in parallel hides per-blob latency. Matches the deploy engine's
 * `PUT_CONCURRENCY` (same storage backend, same rationale); capped so a many-file
 * clone can't exhaust the S3 client's socket pool or trip request-rate limits.
 */
const COPY_CONCURRENCY = 8;

export interface CloneResult {
  canvas: Canvas;
}

/**
 * Clone a canvas into a brand-new canvas owned by the caller (plan 002).
 *
 * The clone is seeded from the source's **published** version manifest, falling
 * back to the source's draft only when it was never published (own-canvas case).
 * Because files are content-addressed, the manifest is reused verbatim and only
 * the distinct blob bytes are copied into the clone's own per-canvas namespace
 * (`storage.copy`) — no reference rewriting, and the source's blobs are untouched
 * (clone, not move). The clone starts as an **unpublished draft**
 * (`currentVersionId = null`, no version history) so the cloner customizes before
 * publishing.
 *
 * Reset vs. carried (R3/R7):
 * - New: id, slug, API key, owner. Title becomes "Copy of <title>".
 * - Carried: description, the source's password (hash + version — the gate grant
 *   is per-canvas, so a copied hash is safe and the cloner re-enters the password
 *   on the new canvas), and lineage (`clonedFromCanvasId`).
 * - Forced off regardless of the source's state: shared, gallery-listed,
 *   templatable, and all gallery metadata (these default false/null in `create`).
 * - Not copied: runtime primitive data (KV, files, usage) — a template is static
 *   content, not another canvas's data.
 */
export function cloneService(deps: CloneServiceDeps) {
  return {
    async clone(source: Canvas, ownerId: string): Promise<CloneResult> {
      // 1. Seeding manifest: published version, else the source's draft.
      let manifest: Manifest = {};
      if (source.currentVersionId) {
        const version = await deps.versions.findById(source.currentVersionId);
        if (version?.manifest) manifest = version.manifest as Manifest;
      } else {
        const draft = await deps.drafts.getByCanvas(source.id);
        if (draft) manifest = draft.manifest as Manifest;
      }

      // 2. Create the new canvas. The fresh deploy key is generated + hashed here
      //    (apiKeyHash is NOT NULL) but the plaintext is intentionally discarded —
      //    a clone's key is revealed on demand via Settings → Regenerate key, so it
      //    never transits the wire (plan 002). backendEnabled is NOT carried — a
      //    clone starts static-first (create defaults it off + cap_* on).
      const slug = await generateUniqueSlug(
        async (s) => (await deps.canvases.findBySlug(s)) !== null,
      );
      const canvas = await deps.canvases.create({
        ownerId,
        slug,
        apiKeyHash: hashApiKey(generateApiKey()),
        title: source.title ? `Copy of ${source.title}` : "Copy of Untitled canvas",
        description: source.description,
        passwordHash: source.passwordHash,
        passwordVersion: source.passwordVersion,
        clonedFromCanvasId: source.id,
      });

      // The DISTINCT blobs to copy (dedup by hash — two paths sharing one hash copy
      // that blob once). Declared outside the try so the rollback can delete exactly
      // these destination keys.
      const hashes = [...new Set(Object.values(manifest).map((entry) => entry.hash))];

      // 3-4. Copy blobs, then seed the draft — but if anything fails after the
      //    canvas row exists, roll it back so a half-cloned, draftless canvas never
      //    survives (opening such a canvas would mint an empty draft and silently
      //    lose the cloned content). Soft-delete + best-effort blob cleanup, then
      //    rethrow so the route still surfaces the original failure.
      try {
        // Copy in bounded-concurrency batches so remote (S3) clones don't pay
        // per-blob round-trip latency serially. Each batch waits for ALL copies to
        // SETTLE before surfacing a failure (allSettled, not all) — mirroring the
        // deploy engine — so no copy is still in flight when the rollback runs.
        for (let i = 0; i < hashes.length; i += COPY_CONCURRENCY) {
          const results = await Promise.allSettled(
            hashes
              .slice(i, i + COPY_CONCURRENCY)
              .map((hash) => deps.storage.copy(blobKey(source.id, hash), blobKey(canvas.id, hash))),
          );
          const failed = results.find((r) => r.status === "rejected");
          if (failed) throw (failed as PromiseRejectedResult).reason;
        }
        // Seed the draft AFTER all blobs land, so a mid-copy failure never leaves a
        // draft referencing a blob that isn't there.
        await deps.drafts.create({ canvasId: canvas.id, manifest, baseVersionId: null });
      } catch (err) {
        // Best-effort rollback. Delete exactly the destination keys we attempted
        // (deleteMany ignores missing ones) rather than list()-ing the prefix — that
        // avoids both a list() throw masking the original error AND any list-after-
        // write consistency gap. Both cleanup steps are guarded so the ORIGINAL error
        // always rethrows; a leaked blob under the now-soft-deleted canvas is reclaimed
        // by the purge sweep.
        await deps.canvases.setStatus(canvas.id, "deleted").catch((rollbackErr) =>
          // A failed soft-delete is the dangerous one: the canvas row stays `active`
          // with an incomplete draft and purge only sweeps `deleted` rows. Log so it
          // doesn't silently leave a half-cloned canvas alive (review server-canvas-17).
          deps.log?.warn(
            { err: rollbackErr, canvasId: canvas.id },
            "clone rollback: soft-delete failed — canvas may remain active half-cloned",
          ),
        );
        await deps.storage
          .deleteMany(hashes.map((hash) => blobKey(canvas.id, hash)))
          .catch((cleanupErr) =>
            deps.log?.warn(
              { err: cleanupErr, canvasId: canvas.id },
              "clone rollback: blob cleanup failed — leaked blobs reclaimed by purge",
            ),
          );
        throw err;
      }

      return { canvas };
    },
  };
}

export type CloneService = ReturnType<typeof cloneService>;

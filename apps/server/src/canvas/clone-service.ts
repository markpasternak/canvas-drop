import type { Canvas, Manifest } from "@canvas-drop/shared/db";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { DraftsRepository } from "../db/repositories/drafts.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { StorageDriver } from "../storage/driver.js";
import { generateApiKey, hashApiKey } from "./api-key.js";
import { generateUniqueSlug } from "./slug.js";
import { blobKey } from "./storage-keys.js";

export interface CloneServiceDeps {
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  drafts: DraftsRepository;
  storage: StorageDriver;
}

export interface CloneResult {
  canvas: Canvas;
  /** The new canvas's API key — returned ONCE (mirrors create). */
  apiKey: string;
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

      // 2. Create the new canvas. backendEnabled is intentionally NOT carried —
      //    a clone starts static-first (create defaults it off + cap_* on).
      const apiKey = generateApiKey();
      const slug = await generateUniqueSlug(
        async (s) => (await deps.canvases.findBySlug(s)) !== null,
      );
      const canvas = await deps.canvases.create({
        ownerId,
        slug,
        apiKeyHash: hashApiKey(apiKey),
        title: source.title ? `Copy of ${source.title}` : "Copy of Untitled canvas",
        description: source.description,
        passwordHash: source.passwordHash,
        passwordVersion: source.passwordVersion,
        clonedFromCanvasId: source.id,
      });

      // 3. Copy the DISTINCT blobs into the clone's namespace (dedup by hash —
      //    two paths sharing one hash copy that blob once).
      const hashes = new Set(Object.values(manifest).map((entry) => entry.hash));
      for (const hash of hashes) {
        await deps.storage.copy(blobKey(source.id, hash), blobKey(canvas.id, hash));
      }

      // 4. Seed the draft AFTER all blobs land, so a mid-copy failure never leaves
      //    a draft referencing a blob that isn't there.
      await deps.drafts.create({ canvasId: canvas.id, manifest, baseVersionId: null });

      return { canvas, apiKey };
    },
  };
}

export type CloneService = ReturnType<typeof cloneService>;

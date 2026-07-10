import type { Canvas, Manifest, Version } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { DeployEngine } from "../deploy/engine.js";
import type { StorageDriver } from "../storage/driver.js";
import { blobKey } from "./storage-keys.js";

/** Match the other storage fan-outs without exhausting the S3 client's socket pool. */
const READ_CONCURRENCY = 8;

export type VersionHistoryErrorCode = "VERSION_NOT_FOUND" | "BLOB_MISSING";

/** Stable domain failure for version archive assembly. */
export class VersionHistoryError extends Error {
  constructor(
    readonly code: VersionHistoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VersionHistoryError";
  }
}

export type DeleteHistoricalResult =
  | { kind: "deleted"; version: Version }
  | { kind: "current" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export interface VersionHistoryDeps {
  versions: VersionsRepository;
  storage: StorageDriver;
  engine: Pick<DeployEngine, "collectGarbage">;
  audit: AuditLog;
}

/**
 * Shared owner-facing version-history operations. Transport layers retain their
 * own owner/mutability gates; this service keeps archive and row-deletion
 * semantics identical across dashboard HTTP and MCP.
 */
export function versionHistoryService(deps: VersionHistoryDeps) {
  return {
    /** Build an all-or-nothing ZIP for one ready version. */
    async archive(
      canvas: Pick<Canvas, "id" | "slug">,
      number: number,
    ): Promise<{ bytes: Uint8Array; filename: string }> {
      const version = await deps.versions.findReadyByNumber(canvas.id, number);
      if (!version?.manifest) {
        throw new VersionHistoryError("VERSION_NOT_FOUND", `no ready version ${number}`);
      }

      const manifestEntries = Object.entries(version.manifest as Manifest);
      const entries: Record<string, Uint8Array> = {};
      for (let i = 0; i < manifestEntries.length; i += READ_CONCURRENCY) {
        const batch = manifestEntries.slice(i, i + READ_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(([, entry]) => deps.storage.get(blobKey(canvas.id, entry.hash))),
        );
        for (const [offset, result] of results.entries()) {
          if (result.status === "rejected") throw result.reason;
          const path = batch[offset]?.[0];
          if (!path || !result.value) {
            throw new VersionHistoryError(
              "BLOB_MISSING",
              `version ${number} is missing the stored bytes for ${path ?? "an unknown file"}`,
            );
          }
          entries[path] = new Uint8Array(result.value);
        }
      }

      const { zipSync } = await import("fflate");
      return { bytes: zipSync(entries), filename: `${canvas.slug}-v${number}.zip` };
    },

    /**
     * Delete one ready non-current row, then sweep blobs against the fresh live
     * set. A null guarded delete is classified with a second read: a surviving
     * row became current; a vanished row became unavailable concurrently.
     */
    async deleteHistorical(
      canvasId: string,
      number: number,
      actorId: string,
    ): Promise<DeleteHistoricalResult> {
      const target = await deps.versions.findReadyByNumber(canvasId, number);
      if (!target) return { kind: "not_found" };

      const deleted = await deps.versions.deleteReadyNonCurrent(canvasId, number);
      if (!deleted) {
        const surviving = await deps.versions.findReadyByNumber(canvasId, number);
        return surviving ? { kind: "current" } : { kind: "unavailable" };
      }

      deps.audit.recordAudit({
        action: "version_delete",
        actorId,
        targetId: canvasId,
        meta: { version: number },
      });
      await deps.engine.collectGarbage(canvasId);
      return { kind: "deleted", version: deleted };
    },
  };
}

export type VersionHistoryService = ReturnType<typeof versionHistoryService>;

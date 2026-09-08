import type { Canvas, Manifest, Version } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import type { DraftsRepository } from "../db/repositories/drafts.js";
import type { UploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import type { UsersRepository } from "../db/repositories/users.js";
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
  drafts: Pick<DraftsRepository, "getByCanvas">;
  uploadSessions?: Pick<UploadSessionsRepository, "listActiveByCanvas">;
  storage: StorageDriver;
  engine: Pick<DeployEngine, "collectGarbage">;
  audit: AuditLog;
}

export interface PruneResult {
  deleted: number[];
  skipped: Array<{ version: number; reason: "current" | "not_found" | "unavailable" }>;
}

export interface PrunePreview {
  versions: number[];
  expectedVersionIds: Record<string, string>;
  skipped: PruneResult["skipped"];
  /** Manifest estimate, not a promise that the storage driver has reclaimed bytes. */
  estimatedReclaimableBytes: number;
}

/**
 * Shared owner-facing version-history operations. Transport layers retain their
 * own owner/mutability gates; this service keeps archive and row-deletion
 * semantics identical across dashboard HTTP and MCP.
 */
/**
 * Who created each version (editor-roles plan U8, R18): one batched lookup of the
 * creators' display identity, shared by the management versions route and the MCP
 * `list_versions` tool. Every version already records `createdBy`; a creator whose
 * account is gone resolves to no entry (the caller shows the id / nothing).
 */
export async function resolveVersionCreators(
  users: Pick<UsersRepository, "findByIds">,
  versions: readonly Pick<Version, "createdBy">[],
): Promise<Map<string, { name: string; email: string }>> {
  const ids = [...new Set(versions.map((v) => v.createdBy))];
  if (ids.length === 0) return new Map();
  return new Map((await users.findByIds(ids)).map((u) => [u.id, { name: u.name, email: u.email }]));
}

export function versionHistoryService(deps: VersionHistoryDeps) {
  return {
    async previewPrune(
      canvas: Pick<Canvas, "id" | "currentVersionId">,
      selection: number[] | "previous",
    ): Promise<PrunePreview> {
      const versions = await deps.versions.listByCanvas(canvas.id);
      const numbers =
        selection === "previous"
          ? versions
              .filter((v) => v.status === "ready" && v.id !== canvas.currentVersionId)
              .map((v) => v.number)
          : [...new Set(selection)];
      const preview: PrunePreview = {
        versions: [],
        expectedVersionIds: {},
        skipped: [],
        estimatedReclaimableBytes: 0,
      };
      const selected = new Set<string>();
      for (const number of numbers) {
        const v = versions.find((v) => v.number === number && v.status === "ready");
        if (!v || v.id === canvas.currentVersionId) {
          preview.skipped.push({ version: number, reason: v ? "current" : "not_found" });
        } else {
          preview.versions.push(number);
          preview.expectedVersionIds[String(number)] = v.id;
          selected.add(v.id);
        }
      }
      const draft = await deps.drafts.getByCanvas(canvas.id);
      const uploads = (await deps.uploadSessions?.listActiveByCanvas(canvas.id, Date.now())) ?? [];
      const retained = new Set<string>();
      const manifests = [
        ...versions
          .filter((v) => v.status === "ready" && !selected.has(v.id))
          .map((v) => v.manifest),
        draft?.manifest,
        ...uploads.map((u) => u.manifest),
      ];
      for (const manifest of manifests) {
        for (const entry of Object.values((manifest ?? {}) as Manifest)) retained.add(entry.hash);
      }
      const candidates = new Map<string, number>();
      for (const version of versions.filter((v) => selected.has(v.id))) {
        for (const entry of Object.values((version.manifest ?? {}) as Manifest)) {
          if (!retained.has(entry.hash)) candidates.set(entry.hash, entry.size);
        }
      }
      preview.estimatedReclaimableBytes = [...candidates.values()].reduce(
        (sum, size) => sum + size,
        0,
      );
      return preview;
    },

    async prune(
      canvasId: string,
      numbers: number[],
      actorId: string,
      expectedVersionIds: Record<string, string>,
    ): Promise<PruneResult> {
      const result: PruneResult = { deleted: [], skipped: [] };
      try {
        for (const number of new Set(numbers)) {
          const expectedId = expectedVersionIds[String(number)];
          const deleted = expectedId
            ? await deps.versions.deleteReadyNonCurrent(canvasId, number, expectedId)
            : null;
          if (deleted) {
            result.deleted.push(number);
            deps.audit.recordAudit({
              action: "version_delete",
              actorId,
              targetId: canvasId,
              meta: { version: number },
            });
          } else {
            const surviving = await deps.versions.findReadyByNumber(canvasId, number);
            result.skipped.push({
              version: number,
              reason: surviving
                ? surviving.id === expectedId
                  ? "current"
                  : "unavailable"
                : "not_found",
            });
          }
        }
      } finally {
        if (result.deleted.length) await deps.engine.collectGarbage(canvasId);
      }
      return result;
    },

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

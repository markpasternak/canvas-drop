import type { DeploySource, Version } from "@canvas-drop/shared/db";
import type { VersionsRepository } from "../db/repositories/versions.js";

/**
 * Neutral home for deploy-domain constants + the shared version-number commit
 * helper, so neither the deploy engine nor the draft service has to import from
 * the other (review server-canvas-10 — that was a bidirectional layer coupling).
 */

/** Published versions kept per canvas; older ready versions are pruned (§6.1.11). */
export const KEEP_VERSIONS = 10;

/**
 * A `pending` version row older than this (by age) is treated as abandoned by the
 * per-canvas prune sweep. Any genuine deploy/finalize reaches `markReady` within a
 * single request (seconds), so an hour is comfortably longer than any in-flight
 * attempt — the sweep can never race a live one. Failed deploys also delete their
 * own pending row inline; this is the safety net for the paths that don't.
 */
export const PENDING_VERSION_TTL_MS = 60 * 60 * 1000;

/** How many times to re-pick a version number on a (canvas_id, number) collision. */
const VERSION_NUMBER_ATTEMPTS = 5;

/**
 * Create the `pending` version row, retrying on a (canvas_id, number) unique-index
 * collision from a concurrent deploy/publish. The single implementation behind both
 * the deploy engine (`deploy()` / `finalize()`) and the draft service (`publish()`),
 * so the collision-retry policy can't drift between the two ingestion paths.
 */
export async function createPendingVersionWithRetry(
  versions: Pick<VersionsRepository, "nextNumber" | "createPending">,
  canvasId: string,
  actorId: string,
  source: DeploySource,
): Promise<Version> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < VERSION_NUMBER_ATTEMPTS; attempt++) {
    const number = await versions.nextNumber(canvasId);
    try {
      return await versions.createPending({ canvasId, number, createdBy: actorId, source });
    } catch (err) {
      lastErr = err; // unique-constraint collision from a concurrent deploy — retry
    }
  }
  throw lastErr;
}

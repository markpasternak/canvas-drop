import type { CanvasStatus } from "../db/types.js";

/**
 * The lifecycle of a canvas as a share — WHETHER it is published — independent of who may
 * open it ({@link AccessMode}). Refines the dashboard's coarser `PublicationState`
 * (draft / published / archived / disabled / deleted) with the two share-level facts the
 * authoring API also tracks: revocation and expiry.
 *
 *  - `disabled`    — an admin took the canvas down (read-only to its owner and editors).
 *  - `archived`    — the owner archived it; nothing serves.
 *  - `unpublished` — the share was revoked (`revokedAt` set): the URL serves nothing until
 *                    a bundle is published again.
 *  - `draft`       — no version has ever been published.
 *  - `expired`     — published, but the share expiry has passed: only the owner and
 *                    editors can still open it.
 *  - `published`   — live.
 *  - `deleted`     — soft-deleted. Owner-facing surfaces omit these rows; the value exists so
 *                    the helper is total over every persisted canvas status.
 *
 * Precedence (first match wins): deleted › disabled › archived › unpublished › draft ›
 * expired › published. Row-level lifecycle outranks share-level facts, revocation outranks
 * the version (a revoked share is dead even when a version still exists), and expiry only
 * matters for something that is otherwise live.
 */
export type PublicationStatus =
  | "draft"
  | "published"
  | "expired"
  | "unpublished"
  | "archived"
  | "disabled"
  | "deleted";

export interface PublicationStatusInput {
  /** The persisted canvas `status` column. */
  status: CanvasStatus | string;
  /** Whether a version is currently served (`currentVersionId !== null`). */
  hasCurrentVersion: boolean;
  /** When the share was revoked through the authoring API, or null. */
  revokedAt: number | null;
  /** The share expiry (unix ms), or null. */
  sharedExpiresAt: number | null;
  /** The clock to judge expiry against (unix ms). */
  now: number;
}

/** Derive the {@link PublicationStatus}. Pure; every projection and surface calls this. */
export function publicationStatusOf(input: PublicationStatusInput): PublicationStatus {
  if (input.status === "deleted") return "deleted";
  if (input.status === "disabled") return "disabled";
  if (input.status === "archived") return "archived";
  if (input.revokedAt !== null) return "unpublished";
  if (!input.hasCurrentVersion) return "draft";
  if (input.sharedExpiresAt !== null && input.sharedExpiresAt <= input.now) return "expired";
  return "published";
}

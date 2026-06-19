import type { Canvas } from "@canvas-drop/shared/db";
import type { CanvasSettingsPatch } from "../db/repositories/canvases.js";
import { cdnAccessDowngradeWarning } from "../http/cdn-cache.js";
import { isAnonymouslyPublic } from "./authorization.js";

/** The settings a caller may change (the management `settingsSchema` shape, minus the
 *  transport concerns). `shared` is the deprecated boolean alias for `access`. */
export interface CanvasSettingsInput {
  title?: string;
  description?: string | null;
  access?: "private" | "specific_people" | "whole_org" | "public_link";
  shared?: boolean;
  guestAiEnabled?: boolean;
  guestAiCap?: number;
  sharedExpiresAt?: number | null;
  password?: string | null;
  spaFallback?: boolean;
  /** Preview policy via settings — only `auto`/`off` here; `custom` is set by uploading. */
  previewMode?: "auto" | "off";
  galleryListed?: boolean;
  galleryTemplatable?: boolean;
  gallerySummary?: string | null;
  tags?: string[];
}

export type SettingsResolution =
  | { ok: false; code: string; message: string; status: 403 | 409 }
  | {
      ok: true;
      /** The persisted settings patch (already enforces the listability invariant). */
      patch: CanvasSettingsPatch;
      /** undefined = leave password unchanged; null = clear; string = set (caller hashes). */
      password: string | null | undefined;
      /** The resolved target access rung, or undefined when unchanged (for the audit event). */
      targetAccess?: "private" | "specific_people" | "whole_org" | "public_link";
      /** Non-blocking advisory for the owner — e.g. CDN edge-cache staleness on an
       *  access downgrade. Present only when there's something worth surfacing. */
      warning?: string;
    };

/**
 * Resolve a canvas-settings change into a persisted patch + the share/gallery
 * preconditions, with NO I/O. The single source of truth behind the management
 * `PATCH /:id/settings` route and the MCP `update_canvas` tool, so the two can't
 * diverge on the listability invariant (templatable ⊆ listed ⊆ shared/published/
 * unprotected), the share-requires-publish rule, or the public_link admin gate.
 *
 * `opts.canPublishPublic` is the caller's per-account admin grant (the `public_link`
 * gate). The caller applies the result: `updateSettings(patch)` + `setPassword(hash)`
 * when `password !== undefined`, then audits `share_change` when `targetAccess` is set.
 */
export function resolveSettingsUpdate(
  cv: Canvas,
  input: CanvasSettingsInput,
  opts: { canPublishPublic: boolean; publicEdgeCacheTtlSec: number; now: number },
): SettingsResolution {
  const { password, shared, access, ...rest } = input;
  // The target rung: the first-class `access` field wins; else the deprecated
  // `shared` boolean maps to whole_org/private; else unchanged (undefined).
  const targetAccess =
    access ?? (shared === undefined ? undefined : shared ? "whole_org" : "private");

  // Listability rules (plan 002 R9/R10/R11), mirroring the galleryVisibilityFilters read
  // predicate so the at-rest row can't reach a listed-but-invisible state.
  const willBeProtected = password === undefined ? cv.passwordHash !== null : password !== null;
  const effectiveAccess = targetAccess ?? cv.access;
  const willBeShared = effectiveAccess !== "private";
  // "Published" means the full lifecycle state (active + a current version), not just
  // "has a version" — an archived canvas keeps its currentVersionId.
  const isPublished = cv.status === "active" && cv.currentVersionId !== null;

  if (targetAccess !== undefined && targetAccess !== "private" && !isPublished) {
    return {
      ok: false,
      code: "SHARE_REQUIRES_PUBLISH",
      message: "Publish this canvas before sharing it.",
      status: 409,
    };
  }
  if (targetAccess === "public_link" && !opts.canPublishPublic) {
    return {
      ok: false,
      code: "PUBLIC_NOT_ALLOWED",
      message: "An administrator must grant your account permission to publish public links.",
      status: 403,
    };
  }
  if (rest.galleryListed === true) {
    if (!willBeShared) {
      return {
        ok: false,
        code: "NOT_SHARED",
        message: "Share this canvas before listing it in the gallery.",
        status: 409,
      };
    }
    if (!isPublished) {
      return {
        ok: false,
        code: "NOT_PUBLISHED",
        message: "Publish this canvas before listing it in the gallery.",
        status: 409,
      };
    }
    if (willBeProtected) {
      return {
        ok: false,
        code: "PASSWORD_PROTECTED",
        message: "Remove the password before listing this canvas in the gallery.",
        status: 409,
      };
    }
  }
  // Setting a password OR un-sharing forces the canvas un-listed.
  const finalListed =
    typeof password === "string" || !willBeShared
      ? false
      : (rest.galleryListed ?? cv.galleryListed);
  if (rest.galleryTemplatable === true && !finalListed) {
    return {
      ok: false,
      code: "NOT_LISTED",
      message: "List this canvas in the gallery before allowing templates.",
      status: 409,
    };
  }

  const patch: CanvasSettingsPatch = { ...rest };
  if (targetAccess !== undefined) patch.access = targetAccess;
  // Dropping to private un-lists but KEEPS the gallery summary/tags (re-sharing restores
  // them); a newly-set password un-lists AND clears the gallery metadata (R10).
  if (targetAccess === "private") {
    patch.galleryListed = false;
    patch.galleryTemplatable = false;
  }
  if (typeof password === "string") {
    patch.galleryListed = false;
    patch.galleryTemplatable = false;
    patch.gallerySummary = null;
    patch.tags = null;
  }

  // CDN staleness advisory: if this change moves the canvas OFF the anonymously-public
  // state (public_link + no password + unexpired share — the only shared-cacheable
  // one), a CDN in front may keep serving the old public page until its edge cache
  // expires. Warn in plain terms, quoting the configured TTL. The expiry dimension is
  // included on both sides so restricting via a past `sharedExpiresAt` warns too, and
  // setting a future expiry on a still-public canvas does not. Suppressed when shared
  // caching is off (TTL 0).
  const effectiveExpiresAt =
    rest.sharedExpiresAt !== undefined ? rest.sharedExpiresAt : cv.sharedExpiresAt;
  const wasAnonPublic = isAnonymouslyPublic(
    cv.access,
    cv.passwordHash !== null,
    cv.sharedExpiresAt,
    opts.now,
  );
  const willBeAnonPublic = isAnonymouslyPublic(
    effectiveAccess,
    willBeProtected,
    effectiveExpiresAt,
    opts.now,
  );
  const warning =
    wasAnonPublic && !willBeAnonPublic
      ? (cdnAccessDowngradeWarning(opts.publicEdgeCacheTtlSec) ?? undefined)
      : undefined;

  return { ok: true, patch, password, targetAccess, warning };
}

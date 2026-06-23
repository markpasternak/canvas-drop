import type { Canvas } from "@canvas-drop/shared/db";
import type { CanvasSettingsPatch } from "../db/repositories/canvases.js";
import { cdnAccessDowngradeWarning } from "../http/cdn-cache.js";
import { isAnonymouslyPublic } from "./authorization.js";

/** The settings a caller may change (the management `settingsSchema` shape, minus the
 *  transport concerns). `shared` is the deprecated boolean alias for `access`. */
export interface CanvasSettingsInput {
  title?: string;
  description?: string | null;
  access?: "private" | "specific_people" | "team" | "whole_org" | "public_link";
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
      targetAccess?: "private" | "specific_people" | "team" | "whole_org" | "public_link";
      /** Non-blocking advisory for the owner — e.g. CDN edge-cache staleness on an
       *  access downgrade. Present only when there's something worth surfacing. */
      warning?: string;
    };

/**
 * Resolve a canvas-settings change into a persisted patch + the share/gallery
 * preconditions, with NO I/O. The single source of truth behind the management
 * `PATCH /:id/settings` route and the MCP `update_canvas` tool, so the two can't
 * diverge on the listability invariant (templatable ⊆ listed ⊆ shared/published/
 * unprotected), the share-requires-publish rule, or the effective public_link gate.
 *
 * `opts.publicLinksEnabled` and `opts.canPublishPublic` are the global + per-account
 * `public_link` gate. The caller applies the result: `updateSettings(patch)` + `setPassword(hash)`
 * when `password !== undefined`, then audits `share_change` when `targetAccess` is set.
 */
export function resolveSettingsUpdate(
  cv: Canvas,
  input: CanvasSettingsInput,
  opts: {
    publicLinksEnabled: boolean;
    canPublishPublic: boolean;
    publicEdgeCacheTtlSec: number;
    now: number;
    /** Whether tenancy is active (plan 002 — an org is configured). When true, a
     *  whole_org canvas must have a home org; see the guard below. */
    tenancyActive: boolean;
  },
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
  if (targetAccess === "public_link") {
    if (!opts.publicLinksEnabled) {
      return {
        ok: false,
        code: "PUBLIC_LINKS_DISABLED",
        message: "Public links are disabled for this instance.",
        status: 403,
      };
    }
    if (!opts.canPublishPublic) {
      return {
        ok: false,
        code: "PUBLIC_NOT_ALLOWED",
        message: "An administrator has revoked this account's permission to publish public links.",
        status: 403,
      };
    }
  }
  // Under active tenancy, whole_org means "members of the canvas's home org" — a canvas
  // with no home org (org_id null: a personal canvas, or a guest/org-less owner's) can't
  // be shared org-wide. Refuse rather than create a 'dead share' that decideCanvasAccess
  // denies to everyone (plan 002 — review fix; the runtime twin of the cutover clamp).
  // Inert tenancy keeps the legacy any-member meaning, so this guard is active-only.
  if (targetAccess === "whole_org" && opts.tenancyActive && cv.orgId === null) {
    return {
      ok: false,
      code: "ORG_REQUIRED",
      message: "Only a canvas homed in an org can be shared with the whole org.",
      status: 409,
    };
  }
  // The `team` rung (plan 003 phase 3) no longer requires a home org or active tenancy: a
  // PERSONAL team can be granted to a personal (org-less) canvas. The actual grant — which
  // teams, owner membership, org-match for org teams — is validated + written by the caller's
  // grant resolver (`resolveTeamGrant`), which returns TEAM_REQUIRED (no teams) / TEAM_FORBIDDEN
  // (invalid), so there's no pure guard to duplicate here.
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
  // Dropping to private un-lists but KEEPS the tags (re-sharing restores listing);
  // a newly-set password un-lists AND clears the gallery tags (R10). The unified
  // `description` (U21) is the canvas's own overview field — NOT gallery-only — so it
  // is never cleared here; only the gallery listing + tags are reset.
  if (targetAccess === "private") {
    patch.galleryListed = false;
    patch.galleryTemplatable = false;
  }
  if (typeof password === "string") {
    patch.galleryListed = false;
    patch.galleryTemplatable = false;
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

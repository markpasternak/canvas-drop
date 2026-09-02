import type { Canvas, CanvasDiscoverability } from "@canvas-drop/shared/db";
import { isRestrictedRung } from "@canvas-drop/shared/db";
import type { CanvasSettingsPatch } from "../db/repositories/canvases.js";
import { cdnAccessDowngradeWarning } from "../http/cdn-cache.js";
import { isAnonymouslyPublic } from "./authorization.js";

/** The settings a caller may change (the management `settingsSchema` shape, minus the
 *  transport concerns). `shared` is the deprecated boolean alias for `access`. */
export interface CanvasSettingsInput {
  title?: string;
  description?: string | null;
  access?: "private" | "specific_people" | "team" | "whole_org" | "public_link";
  discoverability?: CanvasDiscoverability;
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
 * `opts.publicLinksEnabled` and `opts.ownerCanPublishPublic` are the global + per-account
 * `public_link` gate — the per-account half is the OWNER's entitlement, whoever acts
 * (editor-roles plan, KD7/R10): an editor without it may still switch a canvas whose
 * owner has it on, and an editor with it may not when the owner lacks it
 * (`PUBLIC_LINK_OWNER_GATED`). The guest-AI opt-in and its spend cap are owner-only
 * (R7): a non-owner's write touching them refuses with `OWNER_ONLY`. The caller applies
 * the result with `updateSettingsAtomic(patch, { passwordHash })`, then audits
 * `share_change` when `targetAccess` is set. Keeping both values in one repository
 * write prevents a public/unprotected intermediate state.
 */
export function resolveSettingsUpdate(
  cv: Canvas,
  input: CanvasSettingsInput,
  opts: {
    publicLinksEnabled: boolean;
    /** The canvas OWNER's per-account publish-public entitlement (never the actor's). */
    ownerCanPublishPublic: boolean;
    /** Whether the acting principal is the owner (the guest-AI fields are owner-only). */
    actorIsOwner: boolean;
    publicEdgeCacheTtlSec: number;
    now: number;
    /** Whether tenancy is active (plan 002 — an org is configured). When true, a
     *  whole_org canvas must have a home org; see the guard below. */
    tenancyActive: boolean;
  },
): SettingsResolution {
  const { password, shared, access, discoverability, ...rest } = input;
  // Owner-only settings (R7): the guest-AI opt-in admits non-org principals to a capability
  // billed to the owner, so only the owner may touch it or its cap.
  if (!opts.actorIsOwner && (rest.guestAiEnabled !== undefined || rest.guestAiCap !== undefined)) {
    return {
      ok: false,
      code: "OWNER_ONLY",
      message: "Only the canvas owner can change the guest AI opt-in or its spend cap.",
      status: 403,
    };
  }
  // The target rung: the first-class `access` field wins; else the deprecated
  // `shared` boolean maps to whole_org/private; else unchanged (undefined).
  const targetAccess =
    access ?? (shared === undefined ? undefined : shared ? "whole_org" : "private");

  // Listability rules (plan 002 R9/R10/R11), mirroring the galleryVisibilityFilters read
  // predicate so the at-rest row can't reach a listed-but-invisible state.
  const willBeProtected = password === undefined ? cv.passwordHash !== null : password !== null;
  const effectiveAccess = targetAccess ?? cv.access;
  const effectiveExpiresAt =
    rest.sharedExpiresAt !== undefined ? rest.sharedExpiresAt : cv.sharedExpiresAt;
  // Only the whole_org rung has an enumeration policy to set: people and teams on the list
  // always see the canvas in Shared (restricted access model), and the restricted family
  // and public_link have no org-wide listing surface. Any other rung pins `link_only`.
  const discoverableAccess = effectiveAccess === "whole_org";
  // Gallery listing is itself an explicit discovery opt-in. For Whole-org canvases,
  // make that single owner action supply the narrower `discoverability='listed'` fact
  // used by both Shared and the org-scoped gallery predicate. Keeping this resolution
  // here preserves HTTP/MCP parity and persists both fields atomically.
  const galleryEnablesOrgDiscovery = rest.galleryListed === true && effectiveAccess === "whole_org";
  const effectiveDiscoverability = galleryEnablesOrgDiscovery
    ? "listed"
    : discoverableAccess
      ? (discoverability ?? cv.discoverability)
      : "link_only";
  const galleryEligible =
    effectiveAccess === "public_link" ||
    (effectiveAccess === "whole_org" && effectiveDiscoverability === "listed");
  // "Shared" here means open beyond the people-and-teams list: the two wide rungs. The
  // restricted family (`private` and its legacy aliases) opens nothing on its own.
  const willBeShared = !isRestrictedRung(effectiveAccess);
  // "Published" means the full lifecycle state (active + a current version), not just
  // "has a version" — an archived canvas keeps its currentVersionId.
  const isPublished = cv.status === "active" && cv.currentVersionId !== null;

  // Opening a canvas to the org or the public before it has anything to show is refused;
  // moving within the restricted family opens nothing, so it needs no publish.
  if (targetAccess !== undefined && !isRestrictedRung(targetAccess) && !isPublished) {
    return {
      ok: false,
      code: "SHARE_REQUIRES_PUBLISH",
      message: "Publish this canvas before sharing it.",
      status: 409,
    };
  }
  const widensPublicExposure =
    effectiveAccess === "public_link" &&
    (targetAccess === "public_link" ||
      (cv.passwordHash !== null && password === null) ||
      (cv.sharedExpiresAt !== null &&
        (effectiveExpiresAt === null || effectiveExpiresAt > cv.sharedExpiresAt)));
  if (widensPublicExposure) {
    if (!opts.publicLinksEnabled) {
      return {
        ok: false,
        code: "PUBLIC_LINKS_DISABLED",
        message: "Public links are disabled for this instance.",
        status: 403,
      };
    }
    if (!opts.ownerCanPublishPublic) {
      // The entitlement follows the OWNER's account (KD7). The owner hears the existing
      // refusal; an editor hears that the owner's account gates it (KTD6, AE6).
      return opts.actorIsOwner
        ? {
            ok: false,
            code: "PUBLIC_NOT_ALLOWED",
            message:
              "An administrator has revoked this account's permission to publish public links.",
            status: 403,
          }
        : {
            ok: false,
            code: "PUBLIC_LINK_OWNER_GATED",
            message:
              "The owner's account can't publish public links, so this canvas can't be made public. An administrator can grant it to the owner.",
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
  // The restricted family (`private` and its legacy aliases `specific_people` / `team`) needs
  // no guard of its own: nothing opens beyond the list, which is managed on the people-list
  // routes. Legacy `teamIds` writes are validated by the caller's grant resolver
  // (`resolveTeamGrant` → TEAM_REQUIRED / TEAM_FORBIDDEN), not here.
  if (rest.galleryListed === true) {
    if (!willBeShared) {
      return {
        ok: false,
        code: "NOT_SHARED",
        message: "Share this canvas before listing it in the gallery.",
        status: 409,
      };
    }
    if (effectiveAccess === "whole_org" && discoverability === "link_only") {
      return {
        ok: false,
        code: "DISCOVERY_CONFLICT",
        message: "A Whole-org canvas cannot be gallery-listed and link-only at the same time.",
        status: 409,
      };
    }
    if (!galleryEligible) {
      return {
        ok: false,
        code: "NOT_GALLERY_ELIGIBLE",
        message: "Only Public link or listed Whole org canvases can be listed in the gallery.",
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
    typeof password === "string" || !willBeShared || !galleryEligible
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
  if (discoverableAccess) {
    if (galleryEnablesOrgDiscovery) patch.discoverability = "listed";
    else if (discoverability !== undefined) patch.discoverability = discoverability;
  } else if (discoverability !== undefined || targetAccess !== undefined) {
    patch.discoverability = "link_only";
  }
  // Dropping to private or setting a password un-lists the canvas but keeps its tags.
  // Tags describe the canvas itself and are not equivalent to gallery publication.
  if (!galleryEligible) {
    patch.galleryListed = false;
    patch.galleryTemplatable = false;
  }
  if (typeof password === "string") {
    patch.galleryListed = false;
    patch.galleryTemplatable = false;
  }

  // CDN staleness advisory: if this change moves the canvas OFF the anonymously-public
  // state (public_link + no password + unexpired share — the only shared-cacheable
  // one), a CDN in front may keep serving the old public page until its edge cache
  // expires. Warn in plain terms, quoting the configured TTL. The expiry dimension is
  // included on both sides so restricting via a past `sharedExpiresAt` warns too, and
  // setting a future expiry on a still-public canvas does not. Suppressed when shared
  // caching is off (TTL 0).
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

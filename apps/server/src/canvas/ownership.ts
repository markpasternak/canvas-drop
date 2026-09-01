import type { Canvas, User } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import type { OrgMembershipResolver } from "../auth/org-membership.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { Logger } from "../log/logger.js";
import { generateApiKey, hashApiKey } from "./api-key.js";
import { editorOrgPredicate } from "./role.js";

/**
 * Ownership moves (editor-roles plan U7, KTD7): the owner-initiated TRANSFER to an
 * existing editor and the admin REASSIGN, through ONE service over ONE composite
 * repository write (`transferOwner`) so both are atomic and cannot drift:
 *
 *   1. upsert the previous owner's direct EDITOR row (only when their account is active
 *      and passes the live org predicate) — written FIRST so a failure after the swap
 *      still leaves both parties with access (SQLite's transaction helper is a
 *      passthrough; the write order is the safety net there);
 *   2. swap `owner_id` in a single CONDITIONAL update (the current owner must still
 *      match — two concurrent transfers → exactly one succeeds);
 *   3. delete any pre-existing people-list row for the new owner (AE16: one row each);
 *   4. revert a `public_link` rung the new owner's account is not entitled to.
 *
 * Audit after commit, naming both parties; sockets revalidated; courtesy emails under
 * the instance's notification settings. Transfer takes a USER id, never an email; a
 * team is never a recipient (KD4).
 */
export type OwnershipErrorCode =
  | "TARGET_NOT_FOUND"
  | "TARGET_BLOCKED"
  | "ALREADY_OWNER"
  | "SELF"
  | "NOT_ELIGIBLE"
  | "TARGET_NOT_MEMBER"
  | "CONFLICT";

export interface OwnershipError {
  ok: false;
  code: OwnershipErrorCode;
  message: string;
}

/** HTTP status per refusal; MCP uses `CODE: message`. */
export const OWNERSHIP_ERROR_STATUS: Record<OwnershipErrorCode, 404 | 409> = {
  TARGET_NOT_FOUND: 404,
  TARGET_BLOCKED: 409,
  ALREADY_OWNER: 409,
  SELF: 409,
  NOT_ELIGIBLE: 409,
  TARGET_NOT_MEMBER: 409,
  CONFLICT: 409,
};

export interface OwnershipResult {
  ok: true;
  canvas: Canvas;
  previousOwnerId: string;
  newOwnerId: string;
  /** Whether the previous owner now holds a direct editor row. */
  previousOwnerEditor: boolean;
  /** Whether a `public_link` rung was reverted because the new owner lacks the entitlement. */
  publicLinkReverted: boolean;
  /** Admin reassign only: the deploy key was rotated (plaintext never returned). */
  deployKeyRotated: boolean;
}

export interface OwnershipNotifier {
  notifyOwnershipReceived(input: {
    canvasSlug: string;
    canvasTitle: string;
    to: string;
    actorName: string;
    mode: "transfer" | "reassign";
  }): Promise<unknown>;
  notifyOwnershipReassignedAway(input: {
    canvasSlug: string;
    canvasTitle: string;
    to: string;
    actorName: string;
    newOwnerEmail: string;
    reason: string;
  }): Promise<unknown>;
}

export interface OwnershipDeps {
  canvases: Pick<
    CanvasesRepository,
    "transferOwner" | "isEffectiveEditor" | "isOwnerPublishEnabled"
  >;
  users: Pick<UsersRepository, "findById">;
  /** Live org membership per user (KTD2). Optional: absent ⇒ ∅ (inert tenancy needs none). */
  orgMembership?: OrgMembershipResolver;
  tenancyActive: boolean;
  audit: AuditLog;
  hub?: { revalidateCanvas(canvasId: string): Promise<void> };
  notify?: OwnershipNotifier;
  log?: Logger;
}

const err = (code: OwnershipErrorCode, message: string): OwnershipError => ({
  ok: false,
  code,
  message,
});

export function ownershipService(deps: OwnershipDeps) {
  const orgIdsOf = async (user: User): Promise<Set<string>> =>
    deps.orgMembership ? deps.orgMembership(user) : new Set<string>();

  const revalidate = async (canvasId: string) => {
    if (!deps.hub) return;
    await deps.hub
      .revalidateCanvas(canvasId)
      .catch((e) => deps.log?.warn({ err: e, canvasId }, "hub: revalidateCanvas failed"));
  };

  /** The recipient must exist and be active. */
  async function loadTarget(toUserId: string): Promise<User | OwnershipError> {
    const target = await deps.users.findById(toUserId);
    if (!target) return err("TARGET_NOT_FOUND", "No such account.");
    if (target.isBlocked) return err("TARGET_BLOCKED", "That account is blocked.");
    return target;
  }

  /** Does the outgoing owner keep editor access? Only an ACTIVE account that passes the
   *  live org predicate (KTD2) gets a direct editor row. */
  async function previousOwnerKeepsEditor(canvas: Canvas): Promise<boolean> {
    const prev = await deps.users.findById(canvas.ownerId);
    if (!prev || prev.isBlocked) return false;
    return editorOrgPredicate(canvas, await orgIdsOf(prev), deps.tenancyActive);
  }

  /** A `public_link` rung follows the OWNER's entitlement (KD7): revert when the new
   *  owner's account may not publish publicly. */
  async function mustRevertPublicLink(canvas: Canvas, toUserId: string): Promise<boolean> {
    return (
      canvas.access === "public_link" && !(await deps.canvases.isOwnerPublishEnabled(toUserId))
    );
  }

  return {
    /**
     * Owner-initiated transfer to an existing editor (R12/R13, AE7): instant, no pending
     * state; the previous owner becomes an editor. The caller has already passed the
     * owner-only gate.
     */
    async transfer(
      canvas: Canvas,
      actor: { id: string; name: string },
      toUserId: string,
    ): Promise<OwnershipResult | OwnershipError> {
      if (toUserId === canvas.ownerId)
        return err("ALREADY_OWNER", "That person already owns this canvas.");
      const target = await loadTarget(toUserId);
      if ("ok" in target) return target;
      const eligible = await deps.canvases.isEffectiveEditor(canvas.id, toUserId, {
        tenancyActive: deps.tenancyActive,
        viewerOrgIds: await orgIdsOf(target),
      });
      if (!eligible) {
        return err(
          "NOT_ELIGIBLE",
          "Ownership can only be transferred to an existing editor who is an org member. Add them as an editor first.",
        );
      }
      const previousOwnerEditor = await previousOwnerKeepsEditor(canvas);
      const revertPublicLink = await mustRevertPublicLink(canvas, toUserId);
      const r = await deps.canvases.transferOwner({
        canvasId: canvas.id,
        fromUserId: canvas.ownerId,
        toUserId,
        previousOwnerEditor,
        revertPublicLink,
      });
      if (!r.swapped)
        return err("CONFLICT", "The canvas changed owner meanwhile; reload and try again.");
      deps.audit.recordAudit({
        action: "canvas_transfer",
        actorId: actor.id,
        targetId: canvas.id,
        meta: {
          from: canvas.ownerId,
          to: toUserId,
          previousOwnerEditor,
          publicLinkReverted: r.publicLinkReverted,
        },
      });
      await revalidate(canvas.id);
      await deps.notify?.notifyOwnershipReceived({
        canvasSlug: canvas.slug,
        canvasTitle: canvas.title,
        to: target.email,
        actorName: actor.name,
        mode: "transfer",
      });
      return {
        ok: true,
        canvas: r.canvas,
        previousOwnerId: canvas.ownerId,
        newOwnerId: toUserId,
        previousOwnerEditor,
        publicLinkReverted: r.publicLinkReverted,
        deployKeyRotated: false,
      };
    },

    /**
     * Admin reassign (R14, AE8/AE17): moves ownership between OTHER members from the admin
     * surface with a recorded reason — never conferring content access on the acting
     * admin. Target: a live member of the canvas's home org (any active member when the
     * canvas has no org), not blocked, not already the owner, never the acting admin. The
     * deploy key is rotated in the same operation (audited as `key_regen` by the admin;
     * the plaintext is never returned — the new owner issues a fresh key).
     */
    async reassign(
      canvas: Canvas,
      admin: { id: string; name: string },
      toUserId: string,
      reason: string,
    ): Promise<OwnershipResult | OwnershipError> {
      if (toUserId === admin.id) return err("SELF", "Reassign to another member, not yourself.");
      if (toUserId === canvas.ownerId)
        return err("ALREADY_OWNER", "That person already owns this canvas.");
      const target = await loadTarget(toUserId);
      if ("ok" in target) return target;
      if (deps.tenancyActive) {
        const orgIds = await orgIdsOf(target);
        const member = canvas.orgId !== null ? orgIds.has(canvas.orgId) : orgIds.size > 0;
        if (!member) {
          return err(
            "TARGET_NOT_MEMBER",
            canvas.orgId !== null
              ? "The new owner must be a member of the canvas's org."
              : "The new owner must be an org member.",
          );
        }
      }
      const previousOwnerEditor = await previousOwnerKeepsEditor(canvas);
      const revertPublicLink = await mustRevertPublicLink(canvas, toUserId);
      // Rotate the deploy key in the same write; the plaintext is discarded on purpose.
      const newApiKeyHash = hashApiKey(generateApiKey());
      const r = await deps.canvases.transferOwner({
        canvasId: canvas.id,
        fromUserId: canvas.ownerId,
        toUserId,
        previousOwnerEditor,
        revertPublicLink,
        newApiKeyHash,
      });
      if (!r.swapped)
        return err("CONFLICT", "The canvas changed owner meanwhile; reload and try again.");
      deps.audit.recordAudit({
        action: "canvas_reassign_owner",
        actorId: admin.id,
        targetId: canvas.id,
        meta: {
          from: canvas.ownerId,
          to: toUserId,
          reason,
          previousOwnerEditor,
          publicLinkReverted: r.publicLinkReverted,
          deployKeyRotated: true,
        },
      });
      deps.audit.recordAudit({
        action: "key_regen",
        actorId: admin.id,
        targetId: canvas.id,
        meta: { byRole: "admin", cause: "owner_reassigned" },
      });
      await revalidate(canvas.id);
      await deps.notify?.notifyOwnershipReceived({
        canvasSlug: canvas.slug,
        canvasTitle: canvas.title,
        to: target.email,
        actorName: admin.name,
        mode: "reassign",
      });
      const prev = await deps.users.findById(canvas.ownerId);
      if (prev && !prev.isBlocked) {
        await deps.notify?.notifyOwnershipReassignedAway({
          canvasSlug: canvas.slug,
          canvasTitle: canvas.title,
          to: prev.email,
          actorName: admin.name,
          newOwnerEmail: target.email,
          reason,
        });
      }
      return {
        ok: true,
        canvas: r.canvas,
        previousOwnerId: canvas.ownerId,
        newOwnerId: toUserId,
        previousOwnerEditor,
        publicLinkReverted: r.publicLinkReverted,
        deployKeyRotated: true,
      };
    },
  };
}

export type OwnershipService = ReturnType<typeof ownershipService>;

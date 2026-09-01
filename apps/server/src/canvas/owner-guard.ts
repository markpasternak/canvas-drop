import type { Canvas } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { AppEnv } from "../http/types.js";
import { memberPrincipal } from "./authorization.js";
import {
  loadManagementGrant,
  type ManagementRole,
  type MinRole,
  type RoleDeps,
  type RoleGrant,
  roleAtLeast,
} from "./role.js";

/** What the HTTP role gate needs: the role resolver's deps plus the by-id load. */
export type CanvasGuardDeps = RoleDeps & {
  canvases: Pick<CanvasesRepository, "findById" | "isEffectiveEditor">;
};

/**
 * Load the canvas named by the `:id` param together with the caller's role on it
 * (`owner` / `editor`), or null when the canvas is missing / deleted or the caller
 * holds no management role (→ 404, no existence leak). THE gate for the dashboard's
 * management + editor/draft surfaces (editor-roles plan, KTD1), shared by
 * management.ts and draft-api.ts so the two security-critical checks can't drift;
 * the MCP tools go through the same `loadManagementGrant`.
 *
 * A non-owner, non-editor admin is treated like any other member here — it gets the
 * same 404 and cannot view, edit, deploy, configure, or delete someone else's canvas.
 * Cross-owner admin power lives only on the dedicated admin routes (§12.0 #3,
 * D-admin-restrict). The role is resolved per request from the gateway-set user and
 * org membership, never from anything the client asserts, and is stashed on the
 * context (`canvasRole`) for handlers that branch on owner vs editor.
 */
export async function requireCanvasRole(
  c: Context<AppEnv>,
  deps: CanvasGuardDeps,
): Promise<RoleGrant | null> {
  const id = c.req.param("id");
  if (!id) return null;
  const orgIds = c.get("orgIds") ?? new Set<string>();
  const grant = await loadManagementGrant(id, memberPrincipal(c.get("user"), orgIds), deps);
  if (grant) c.set("canvasRole", grant.role);
  return grant;
}

/**
 * The single, shared error contract for "this owner action is refused because an admin
 * has taken the canvas down" (status === "disabled"). A disabled canvas is **read-only
 * to its owner and editors**: every MUTATION (settings, capabilities, slug, preview,
 * access / sharing / guests, tags, deploy / publish / rollback, archive / unpublish,
 * draft edits) rejects with this exact shape, while READS (detail, versions, usage,
 * list) stay allowed so the canvas and the takedown reason are still visible.
 *
 * Code is `DISABLED`, HTTP 409 (the row exists and the caller may manage it — it isn't
 * a 404 existence question, it's a state conflict). The owner-facing `disabledReason`
 * (when an admin set one) is appended so the message itself explains *why*. Used by
 * both the HTTP management/draft routes and the MCP mutation tools so the wording
 * can't drift.
 *
 * Archived is NOT disabled: archive is owner-initiated and reversible, so it keeps its own
 * `NOT_ACTIVE` / `NOT_ARCHIVED` semantics. Deleted stays a 404 (no existence leak). This
 * gate is only for the admin takedown.
 */
export const DISABLED_CODE = "DISABLED" as const;

const DISABLED_BASE_MESSAGE = "This canvas has been disabled by an administrator.";

/** The owner-facing message for a disabled canvas, with the admin's reason appended when set. */
export function disabledMessage(cv: Pick<Canvas, "disabledReason">): string {
  const reason = cv.disabledReason?.trim();
  return reason ? `${DISABLED_BASE_MESSAGE} Reason: ${reason}` : DISABLED_BASE_MESSAGE;
}

/** The `{ code, message }` body for a refused mutation on a disabled canvas (HTTP 409). */
export function disabledError(cv: Pick<Canvas, "disabledReason">): {
  code: typeof DISABLED_CODE;
  message: string;
} {
  return { code: DISABLED_CODE, message: disabledMessage(cv) };
}

/**
 * The refusal for an OWNER-ONLY act attempted by an editor (editor-roles plan, KTD6 /
 * KD12): delete, transfer, changing the owner's own entry, the guest-AI opt-in. An
 * editor legitimately knows the canvas exists, so this is an explicit HTTP 403
 * `{ code: "OWNER_ONLY", message }` (MCP: `fail("OWNER_ONLY: …")`) — unlike a caller
 * with NO role, who keeps the bare 404 / "canvas not found" (§12.0 no-existence-leak).
 */
export const OWNER_ONLY_CODE = "OWNER_ONLY" as const;
export const OWNER_ONLY_MESSAGE = "Only the canvas owner can do this.";

/** The `{ code, message }` body for an owner-only refusal (HTTP 403). */
export function ownerOnlyError(): { code: typeof OWNER_ONLY_CODE; message: string } {
  return { code: OWNER_ONLY_CODE, message: OWNER_ONLY_MESSAGE };
}

/**
 * The mutation-gate POLICY, in one place: classify a {@link requireCanvasRole} /
 * `loadManagementGrant` result into a discriminated outcome so every mutation surface
 * applies the SAME ordering and meaning, and only the *response shape* lives in the
 * caller. Check order is fixed (KTD1): role → owner-only act → disabled state.
 *
 * - `not-found` — no management role / missing / deleted (the `grant === null` case).
 *   Maps to a 404 with no existence leak (§12.0): the role is checked BEFORE state, so a
 *   no-role caller (incl. a non-owner admin) of a disabled canvas still reads as
 *   not-found, never the 409 — which would leak that the row exists.
 * - `owner-only` — the caller is an editor and the act needs `min: "owner"`. Maps to the
 *   shared 403 `OWNER_ONLY` refusal. Checked BEFORE `disabled`, so an editor calling
 *   delete on a disabled canvas hears "owner only", not "disabled".
 * - `disabled` — may manage, but an admin has taken it down (`status === "disabled"`).
 *   Maps to the shared 409 `DISABLED` refusal; carries the canvas so the caller can
 *   build the body (the owner-facing reason).
 * - `ok` — may manage and mutable. Carries the canvas and the admitting role.
 */
export type MutabilityOutcome =
  | { kind: "not-found" }
  | { kind: "owner-only"; canvas: Canvas }
  | { kind: "disabled"; canvas: Canvas; role: ManagementRole }
  | { kind: "ok"; canvas: Canvas; role: ManagementRole };

/** Apply the mutation policy to a role-gate result. `min` defaults to editor (KD3). */
export function classifyMutability(
  grant: RoleGrant | null,
  min: MinRole = "editor",
): MutabilityOutcome {
  if (!grant) return { kind: "not-found" };
  if (!roleAtLeast(grant.role, min)) return { kind: "owner-only", canvas: grant.canvas };
  if (grant.canvas.status === "disabled") {
    return { kind: "disabled", canvas: grant.canvas, role: grant.role };
  }
  return { kind: "ok", canvas: grant.canvas, role: grant.role };
}

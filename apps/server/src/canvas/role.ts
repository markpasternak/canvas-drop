import type { Canvas } from "@canvas-drop/shared/db";
import { z } from "zod";
import type { CanvasesRepository, EditorScope } from "../db/repositories/canvases.js";
import type { Principal } from "../http/types.js";

/** The zod boundary for a people-list role (KTD3: unchecked column, validated here). */
export const accessRoleSchema = z.enum(["viewer", "editor"]);

/**
 * The per-canvas role of a principal (editor-roles plan, KTD1):
 *  - `owner`  — the single account on the canvas record; every action.
 *  - `editor` — owner-equivalent except the owner-only acts (KD3). An org member
 *               holding a direct editor row or membership of an editor-role team,
 *               under the LIVE org predicate (KTD2).
 *  - `viewer` — informational: on the people list as a viewer. View reachability
 *               itself stays with `decideCanvasAccess` (the access ladder).
 *  - `none`   — no role. On the management surface this reads as not-found (§12.0).
 *
 * Resolved per request from the server-side principal, never cached on a session or
 * an MCP caller object, so removal / demotion / org departure take effect on the very
 * next request (R22).
 */
export type CanvasRole = "owner" | "editor" | "viewer" | "none";

/** The roles admitted to the owner management / editor surface. */
export type ManagementRole = "owner" | "editor";

/** The minimum role a management route / MCP tool requires. */
export type MinRole = ManagementRole;

const RANK: Record<CanvasRole, number> = { none: 0, viewer: 1, editor: 2, owner: 3 };

/** THE owner comparison — the resolver's owner branch. The only other `ownerId`
 *  comparison is the pure view-access decision table in `authorization.ts` (its owner
 *  bypass, which has no principal-with-role to hand this function);
 *  the few non-gate uses (a list label, an "already the owner" refusal, hiding the owner's
 *  stale people-list row) call this so the comparison lives in exactly one place. */
export function isOwnerOf(canvas: Pick<Canvas, "ownerId">, userId: string): boolean {
  return canvas.ownerId === userId;
}

/**
 * The role label for a row the owned-or-edited LIST query returned (KTD9): the query's
 * predicate already admitted the row as owned or effectively edited, so the label is
 * the owner branch, else editor. Display-only — never an authorization input.
 */
export function listedRole(canvas: Pick<Canvas, "ownerId">, actorId: string): ManagementRole {
  return isOwnerOf(canvas, actorId) ? "owner" : "editor";
}

/** The acts only the owner may perform (R7), echoed by `get_canvas` for agents. */
export const OWNER_ONLY_ACTS = ["delete", "transfer", "guest_ai"] as const;

export function roleAtLeast(role: CanvasRole, min: CanvasRole): boolean {
  return RANK[role] >= RANK[min];
}

export interface RoleDeps {
  /** The effective-editor probe — the canvases repo, or any object exposing the same
   *  method (the realtime hub passes a probe so its deps stay function-shaped). */
  canvases: Pick<CanvasesRepository, "isEffectiveEditor">;
  /** Whether an org is configured (`!!config.org.name`) — the KTD2 predicate's switch. */
  tenancyActive: boolean;
}

/**
 * KTD2's org predicate as a pure function (mirrors the SQL predicate in the canvases
 * repo): under inert tenancy any member qualifies; under active tenancy the member needs
 * a non-empty live org set that contains the canvas's home org when it has one.
 */
export function editorOrgPredicate(
  canvas: Pick<Canvas, "orgId">,
  orgIds: Set<string>,
  tenancyActive: boolean,
): boolean {
  if (!tenancyActive) return true;
  if (orgIds.size === 0) return false;
  return canvas.orgId === null || orgIds.has(canvas.orgId);
}

/** The editor-predicate scope for a member principal (KTD2). */
export function editorScopeFor(
  principal: { orgIds: Set<string> },
  tenancyActive: boolean,
): EditorScope {
  return { tenancyActive, viewerOrgIds: principal.orgIds };
}

/**
 * THE role resolver (KTD1) — every owner gate calls this instead of comparing
 * `ownerId` to the caller. Check order: owner → effective editor (direct row or
 * editor-role team, with the live org predicate, as ONE SQL predicate on the
 * canvases repo) → none. This is the only place the owner comparison lives.
 *
 * Only a `member` principal can hold a role: a guest (KD2) or anonymous visitor is
 * `none` here — their view access is decided by the access ladder, never by a role.
 */
export async function resolveManagementRole(
  canvas: Pick<Canvas, "id" | "ownerId" | "orgId">,
  principal: Principal,
  deps: RoleDeps,
): Promise<ManagementRole | "none"> {
  if (principal.kind !== "member") return "none";
  if (isOwnerOf(canvas, principal.id)) return "owner";
  const editor = await deps.canvases.isEffectiveEditor(
    canvas.id,
    principal.id,
    editorScopeFor(principal, deps.tenancyActive),
  );
  return editor ? "editor" : "none";
}

/**
 * The full four-way role: {@link resolveManagementRole}, then `viewer` when the
 * member holds a direct people-list row (informational — view reachability stays with
 * `decideCanvasAccess`). Used where the distinction is shown, not for gating.
 */
export async function resolveCanvasRole(
  canvas: Pick<Canvas, "id" | "ownerId" | "orgId">,
  principal: Principal,
  deps: RoleDeps & { canvases: Pick<CanvasesRepository, "findMemberEntry"> },
): Promise<CanvasRole> {
  const role = await resolveManagementRole(canvas, principal, deps);
  if (role !== "none" || principal.kind !== "member") return role;
  const direct = await deps.canvases.findMemberEntry(canvas.id, principal.id);
  return direct ? "viewer" : "none";
}

/** A canvas the caller may manage, with the role that admitted them. */
export interface RoleGrant {
  canvas: Canvas;
  role: ManagementRole;
}

/**
 * Resolve the management grant for a loaded canvas: the canvas plus `owner` /
 * `editor`, or null when the canvas is missing / deleted or the principal holds no
 * management role (viewer or none) — the single not-found shape (§12.0 no
 * existence leak). Shared by the HTTP owner guard, the MCP gate, and the
 * peripheral seams so the check cannot drift.
 */
export async function resolveManagementGrant(
  canvas: Canvas | null,
  principal: Principal,
  deps: RoleDeps,
): Promise<RoleGrant | null> {
  if (!canvas || canvas.status === "deleted") return null;
  const role = await resolveManagementRole(canvas, principal, deps);
  if (role === "none") return null;
  return { canvas, role };
}

/**
 * Load a canvas by id and resolve the management grant in one step — the non-HTTP
 * form of the gate, used by the MCP tools and the peripheral seams.
 */
export async function loadManagementGrant(
  id: string,
  principal: Principal,
  deps: RoleDeps & { canvases: Pick<CanvasesRepository, "findById"> },
): Promise<RoleGrant | null> {
  const canvas = await deps.canvases.findById(id);
  return resolveManagementGrant(canvas, principal, deps);
}

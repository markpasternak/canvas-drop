import type { AccessRole, Canvas } from "@canvas-drop/shared/db";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";
import { isOwnerOf } from "./role.js";

/**
 * One row of a canvas's unified people list (editor-roles plan, KTD5): the owner pinned
 * first, then active people (org members and legacy guest rows), pending invitees, and
 * team grants. Every row carries a role and a STABLE entry id the set-role / revoke
 * surfaces address:
 *
 *   `owner` · `member:<rowId>` · `guest:<rowId>` · `pending:<invitationId>` · `team:<teamId>`
 *
 * Shared by the management `GET /:id/allowlist` route and the MCP `list_access` tool so
 * the two transports return identical entries.
 */
export type PeopleEntryKind = "owner" | "member" | "guest" | "pending" | "team";

export interface PeopleEntry {
  id: string;
  kind: PeopleEntryKind;
  /** `owner` for the owner row; otherwise the entry's access role (guests are always viewers). */
  role: "owner" | AccessRole;
  email: string | null;
  name: string | null;
  /** The account behind an owner / member row. */
  userId: string | null;
  /** The team behind a team row. */
  teamId: string | null;
  /** The team's org (null = a personal team) so the UI can label scope truthfully even
   *  when the viewer isn't on that team (review #20). Null on non-team rows. */
  teamOrgId: string | null;
  createdAt: number;
}

export interface PeopleListDeps {
  canvases: Pick<CanvasesRepository, "listAllowlist">;
  users: Pick<UsersRepository, "findByIds">;
  /** Pending (auth-delegated) invitations. Optional: suites without invites omit it. */
  invitations?: Pick<InvitationsRepository, "listPendingForTarget">;
  /** Team grants. Optional: suites that don't exercise teams omit it. */
  teams?: Pick<TeamsRepository, "listCanvasTeamGrants" | "findByIds">;
}

/** Resolve the unified people list for a canvas — one batched user lookup, no N+1 on people. */
export async function resolvePeopleList(
  deps: PeopleListDeps,
  canvas: Pick<Canvas, "id" | "ownerId" | "createdAt">,
): Promise<PeopleEntry[]> {
  const entries = await deps.canvases.listAllowlist(canvas.id);
  const memberIds = entries
    .filter((e) => e.principalKind === "member" && e.userId)
    .map((e) => e.userId as string);
  const byId = new Map(
    (await deps.users.findByIds([canvas.ownerId, ...memberIds])).map((u) => [u.id, u]),
  );

  const owner = byId.get(canvas.ownerId);
  const ownerRow: PeopleEntry = {
    id: "owner",
    kind: "owner",
    role: "owner",
    email: owner?.email ?? null,
    name: owner?.name ?? null,
    userId: canvas.ownerId,
    teamId: null,
    teamOrgId: null,
    createdAt: canvas.createdAt,
  };

  const active: PeopleEntry[] = entries
    // A stale member row for the owner (pre-transfer history) never shows twice (AE16).
    .filter((e) => !(e.principalKind === "member" && e.userId && isOwnerOf(canvas, e.userId)))
    .map((e) => {
      const u = e.userId ? byId.get(e.userId) : undefined;
      const kind = e.principalKind;
      return {
        id: `${kind}:${e.id}`,
        kind,
        // A guest row is always a viewer (KD2), whatever a stale column says.
        role: kind === "guest" ? "viewer" : e.role,
        email: kind === "member" ? (u?.email ?? null) : e.email,
        name: u?.name ?? null,
        userId: kind === "member" ? (e.userId ?? null) : null,
        teamId: null,
        teamOrgId: null,
        createdAt: e.createdAt,
      };
    });

  const activeEmails = new Set(
    active.map((e) => e.email?.trim().toLowerCase()).filter((e): e is string => !!e),
  );
  const pendingRows: PeopleEntry[] = (
    deps.invitations ? await deps.invitations.listPendingForTarget("canvas", canvas.id) : []
  )
    .filter((inv) => !activeEmails.has(inv.email.trim().toLowerCase()))
    .map((inv) => ({
      id: `pending:${inv.id}`,
      kind: "pending" as const,
      role: inv.role === "editor" ? ("editor" as const) : ("viewer" as const),
      email: inv.email,
      name: null,
      userId: null,
      teamId: null,
      teamOrgId: null,
      createdAt: inv.createdAt,
    }));

  const teamRows: PeopleEntry[] = [];
  if (deps.teams) {
    const grants = await deps.teams.listCanvasTeamGrants(canvas.id);
    // One batched team lookup (review #14) — the same shape as the member lookup above.
    const teamById = new Map(
      (await deps.teams.findByIds(grants.map((g) => g.teamId))).map((tm) => [tm.id, tm]),
    );
    for (const grant of grants) {
      const team = teamById.get(grant.teamId);
      teamRows.push({
        id: `team:${grant.teamId}`,
        kind: "team",
        role: grant.role,
        email: null,
        name: team?.name ?? null,
        userId: null,
        teamId: grant.teamId,
        teamOrgId: team?.orgId ?? null,
        createdAt: grant.createdAt,
      });
    }
  }

  return [ownerRow, ...active, ...pendingRows, ...teamRows];
}

/**
 * A people-list entry id, parsed. `row` is a LEGACY bare allowlist row id from before the
 * prefix change (KTD5) — still accepted by set-role and revoke; the kind is resolved by
 * lookup.
 */
export type ParsedEntryId =
  | { kind: "owner" }
  | { kind: "member" | "guest" | "row"; rowId: string }
  | { kind: "pending"; invitationId: string }
  | { kind: "team"; teamId: string };

export function parseEntryId(id: string): ParsedEntryId {
  if (id === "owner") return { kind: "owner" };
  const sep = id.indexOf(":");
  if (sep === -1) return { kind: "row", rowId: id };
  const prefix = id.slice(0, sep);
  const rest = id.slice(sep + 1);
  switch (prefix) {
    case "member":
    case "guest":
      return { kind: prefix, rowId: rest };
    case "pending":
      return { kind: "pending", invitationId: rest };
    case "team":
      return { kind: "team", teamId: rest };
    default:
      // An unknown prefix is treated as an opaque legacy id (it will simply not match).
      return { kind: "row", rowId: id };
  }
}

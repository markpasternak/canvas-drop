import type { AccessRole, Canvas } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { InviteResult, InviteService } from "../invites/service.js";
import type { Logger } from "../log/logger.js";
import { canGrantTeam } from "../teams/sharing.js";
import { type PeopleEntry, parseEntryId, resolvePeopleList } from "./allowlist-view.js";
import type { ManagementRole } from "./role.js";

/**
 * The people-list mutation layer (editor-roles plan U4/U5, R8): add a person or a team
 * with a role, change an entry's role, remove an entry. ONE implementation the HTTP
 * management routes AND the MCP tools wrap — never a parallel copy (the agent-native
 * parity rule) — so the owner-only / guest-viewer-only / not-found rules, the audit
 * events, the courtesy emails, and the socket revalidation cannot drift between the two.
 *
 * The caller has already passed the role gate (owner or editor); `actor.role` is the
 * admitting role, used only to decide whether the owner gets the "someone else granted an
 * editor" notice. Every change is audited with the acting user (KTD15).
 */
export interface PeopleActor {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  role: ManagementRole;
}

export type PeopleErrorCode =
  | "OWNER_ONLY"
  | "GUEST_VIEWER_ONLY"
  | "NOT_FOUND"
  | "TEAM_FORBIDDEN"
  | "INVALID_REQUEST"
  | "EMAIL_NOT_CONFIGURED";

export interface PeopleError {
  ok: false;
  code: PeopleErrorCode;
  message: string;
}

/** The HTTP status each refusal maps to (KTD6); MCP uses `CODE: message`. */
export const PEOPLE_ERROR_STATUS: Record<PeopleErrorCode, 400 | 403 | 404 | 503> = {
  OWNER_ONLY: 403,
  GUEST_VIEWER_ONLY: 400,
  NOT_FOUND: 404,
  TEAM_FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  EMAIL_NOT_CONFIGURED: 503,
};

const ERR = {
  ownerOnly: (): PeopleError => ({
    ok: false,
    code: "OWNER_ONLY",
    message: "Only the canvas owner can do this.",
  }),
  guestViewerOnly: (): PeopleError => ({
    ok: false,
    code: "GUEST_VIEWER_ONLY",
    message: "Only org members can be editors; guests can only view.",
  }),
  notFound: (): PeopleError => ({ ok: false, code: "NOT_FOUND", message: "not_found" }),
  teamForbidden: (): PeopleError => ({
    ok: false,
    code: "TEAM_FORBIDDEN",
    message: "You can only share with teams you belong to in this org.",
  }),
  emailNotConfigured: (): PeopleError => ({
    ok: false,
    code: "EMAIL_NOT_CONFIGURED",
    message: "Invites are unavailable.",
  }),
};

export interface PeopleServiceDeps {
  canvases: Pick<
    CanvasesRepository,
    "listAllowlist" | "findAllowlistEntry" | "setAllowlistRole" | "removeAllowlistEntry"
  >;
  users: Pick<UsersRepository, "findByIds" | "findById">;
  invitations?: Pick<
    InvitationsRepository,
    "listPendingForTarget" | "cancelPendingForTarget" | "findPendingForTarget" | "setPendingRole"
  >;
  teams?: Pick<
    TeamsRepository,
    | "listCanvasTeamGrants"
    | "findById"
    | "findByIds"
    | "isTeamMember"
    | "setCanvasTeamRole"
    | "removeCanvasTeam"
  >;
  /** The Add person primitive — grants, pending invites, courtesy emails. Optional: a
   *  deployment without it can list / set roles / remove, but not add by email. */
  invites?: InviteService;
  /** Legacy guest service — revoking a guest row also revokes its sessions. */
  guests?: { revokeInvite(canvasId: string, email: string): Promise<unknown> };
  audit: AuditLog;
  /** Realtime hub: every access-narrowing change drops the sockets it no longer admits. */
  hub?: { revalidateCanvas(canvasId: string): Promise<void> };
  log?: Logger;
}

export type AddPersonOutcome = { ok: true; result: InviteResult; role: AccessRole | null };
export type PeopleOk = { ok: true };
/** A team grant's outcome — mirrors addPerson's statuses so callers can tell a fresh
 *  grant from a role change (review #15). */
export type TeamGrantOk = {
  ok: true;
  status: "granted" | "role_changed" | "already_added";
  role: AccessRole;
  from: AccessRole | null;
};

export function peopleService(deps: PeopleServiceDeps) {
  const revalidate = async (canvasId: string) => {
    if (!deps.hub) return;
    await deps.hub
      .revalidateCanvas(canvasId)
      .catch((err) => deps.log?.warn({ err, canvasId }, "hub: revalidateCanvas failed"));
  };

  /** The owner's "someone else made X an editor" notice (R21) — only when a NON-owner acted. */
  async function notifyOwnerIfNeeded(canvas: Canvas, actor: PeopleActor, personEmail: string) {
    if (actor.role === "owner" || !deps.invites) return;
    const owner = await deps.users.findById(canvas.ownerId);
    if (!owner) return;
    await deps.invites.notifyOwnerOfEditorGrant({
      canvasSlug: canvas.slug,
      canvasTitle: canvas.title,
      ownerEmail: owner.email,
      personEmail,
      actor: { id: actor.id, name: actor.name, email: actor.email, isAdmin: actor.isAdmin },
    });
  }

  /** A member/guest/legacy row entry by parsed id, scoped to THIS canvas (§12.0); a
   *  prefixed id whose kind disagrees with the row reads as not found. */
  async function resolveRowEntry(
    canvas: Canvas,
    parsed: { kind: "member" | "guest" | "row"; rowId: string },
  ) {
    const entry = await deps.canvases.findAllowlistEntry(canvas.id, parsed.rowId);
    if (!entry) return null;
    if (parsed.kind !== "row" && parsed.kind !== entry.principalKind) return null;
    return entry;
  }

  return {
    /** The unified people list (KTD5). */
    list(canvas: Canvas): Promise<PeopleEntry[]> {
      return resolvePeopleList(deps, canvas);
    },

    /**
     * Add a person by email with a role (default viewer): an existing user is granted now
     * (an existing row's role is updated when a role was supplied — KTD3), a brand-new
     * admissible email becomes a pending grant carrying the role. Editor is refused for a
     * guest / non-org email (GUEST_VIEWER_ONLY, KD2/KTD2).
     */
    async addPerson(
      canvas: Canvas,
      actor: PeopleActor,
      input: { email: string; role?: AccessRole; mode: "add" | "invite" },
    ): Promise<AddPersonOutcome | PeopleError> {
      if (!deps.invites) return ERR.emailNotConfigured();
      const result = await deps.invites.resolveOrInvite(
        {
          kind: "canvas",
          canvasId: canvas.id,
          canvasSlug: canvas.slug,
          canvasTitle: canvas.title,
          mode: input.mode,
          role: input.role,
        },
        input.email,
        { id: actor.id, name: actor.name, email: actor.email, isAdmin: actor.isAdmin },
      );
      if (result.status === "guest_viewer_only") return ERR.guestViewerOnly();
      deps.audit.recordAudit({
        action: result.status === "role_changed" ? "allowlist_role_change" : "allowlist_add",
        actorId: actor.id,
        targetId: canvas.id,
        meta: {
          kind: "add_person",
          mode: input.mode,
          status: result.status,
          role: input.role ?? null,
          ...(result.status === "role_changed" ? { from: result.from } : {}),
        },
      });
      if (
        (result.status === "granted" ||
          result.status === "pending" ||
          result.status === "role_changed") &&
        input.role === "editor"
      ) {
        await notifyOwnerIfNeeded(canvas, actor, input.email.trim().toLowerCase());
      }
      // A role change via add can NARROW access (editor → viewer): drop stale sockets.
      if (result.status === "role_changed") await revalidate(canvas.id);
      return { ok: true, result, role: input.role ?? null };
    },

    /**
     * Grant a team with a role (U5). The actor must be a live member of the team; an org
     * team must match the canvas's org (the same KTD4 rule as the settings flow). A viewer
     * team grant keeps today's `team`-rung semantics; an editor team grant is effective at
     * every rung.
     */
    async addTeam(
      canvas: Canvas,
      actor: PeopleActor,
      input: { teamId: string; role?: AccessRole },
    ): Promise<TeamGrantOk | PeopleError> {
      if (!deps.teams) return ERR.teamForbidden();
      const team = await canGrantTeam(deps.teams, actor.id, canvas.orgId, input.teamId);
      if (!team) return ERR.teamForbidden();
      const existing = (await deps.teams.listCanvasTeamGrants(canvas.id)).find(
        (g) => g.teamId === input.teamId,
      );
      // An omitted role never changes an existing grant (KTD3, the same rule as people;
      // review #15): re-adding an editor team keeps it an editor.
      const role: AccessRole = input.role ?? existing?.role ?? "viewer";
      if (existing && existing.role === role) {
        return { ok: true, status: "already_added", role, from: existing.role };
      }
      await deps.teams.setCanvasTeamRole(canvas.id, input.teamId, role);
      deps.audit.recordAudit({
        action: "share_change",
        actorId: actor.id,
        targetId: canvas.id,
        meta: {
          kind: "team_grant",
          teamId: input.teamId,
          role,
          from: existing?.role ?? null,
        },
      });
      if (existing && existing.role !== role) await revalidate(canvas.id);
      return {
        ok: true,
        status: existing ? "role_changed" : "granted",
        role,
        from: existing?.role ?? null,
      };
    },

    /**
     * Change one entry's role. The `owner` entry is owner-only for everyone (R7); a guest
     * is never an editor (AE1); a pending editor needs an org-domain email (AE15); a
     * member's promotion to editor needs an org account (KTD2). Demotion revalidates live
     * sockets exactly like a removal (R22).
     */
    async setRole(
      canvas: Canvas,
      actor: PeopleActor,
      entryId: string,
      role: AccessRole,
    ): Promise<PeopleOk | PeopleError> {
      const parsed = parseEntryId(entryId);
      if (parsed.kind === "owner") return ERR.ownerOnly();

      if (parsed.kind === "team") {
        if (!deps.teams) return ERR.notFound();
        const grant = (await deps.teams.listCanvasTeamGrants(canvas.id)).find(
          (g) => g.teamId === parsed.teamId,
        );
        if (!grant) return ERR.notFound();
        if (grant.role === role) return { ok: true };
        await deps.teams.setCanvasTeamRole(canvas.id, parsed.teamId, role);
        deps.audit.recordAudit({
          action: "share_change",
          actorId: actor.id,
          targetId: canvas.id,
          meta: { kind: "team_grant", teamId: parsed.teamId, role, from: grant.role },
        });
        await revalidate(canvas.id);
        return { ok: true };
      }

      if (parsed.kind === "pending") {
        if (!deps.invitations) return ERR.notFound();
        const inv = await deps.invitations.findPendingForTarget(
          "canvas",
          canvas.id,
          parsed.invitationId,
        );
        if (!inv) return ERR.notFound();
        const from: AccessRole = inv.role === "editor" ? "editor" : "viewer";
        if (from === role) return { ok: true };
        if (
          role === "editor" &&
          !(deps.invites && (await deps.invites.canHoldEditorRole(inv.email)))
        ) {
          return ERR.guestViewerOnly();
        }
        // Conditional on the invite still being pending (review #3): if login
        // materialization consumed it in between, the row is gone and reporting success
        // here would audit a role change that never applied.
        const changed = await deps.invitations.setPendingRole(
          "canvas",
          canvas.id,
          parsed.invitationId,
          role,
        );
        if (!changed) return ERR.notFound();
        deps.audit.recordAudit({
          action: "allowlist_role_change",
          actorId: actor.id,
          targetId: canvas.id,
          meta: { entryId, kind: "pending", email: inv.email, role, from },
        });
        if (role === "editor") await notifyOwnerIfNeeded(canvas, actor, inv.email);
        return { ok: true };
      }

      // member / guest / legacy bare row id — scoped to THIS canvas by the repo (§12.0).
      const entry = await resolveRowEntry(canvas, parsed);
      if (!entry) return ERR.notFound();
      if (entry.principalKind === "guest") {
        return role === "editor" ? ERR.guestViewerOnly() : { ok: true };
      }
      if (entry.role === role) return { ok: true };
      const person = entry.userId ? await deps.users.findById(entry.userId) : null;
      if (
        role === "editor" &&
        !(person && deps.invites && (await deps.invites.canHoldEditorRole(person.email)))
      ) {
        return ERR.guestViewerOnly();
      }
      const updated = await deps.canvases.setAllowlistRole(canvas.id, entry.id, role);
      if (!updated) return ERR.notFound();
      deps.audit.recordAudit({
        action: "allowlist_role_change",
        actorId: actor.id,
        targetId: canvas.id,
        meta: { entryId, kind: "member", userId: entry.userId, role, from: entry.role },
      });
      if (role === "editor" && person && deps.invites) {
        // The existing courtesy email, now naming the role (R21).
        await deps.invites.notifyCanvasRole(
          {
            kind: "canvas",
            canvasId: canvas.id,
            canvasSlug: canvas.slug,
            canvasTitle: canvas.title,
            mode: "add",
            role,
          },
          person.email,
          { id: actor.id, name: actor.name, email: actor.email, isAdmin: actor.isAdmin },
        );
        await notifyOwnerIfNeeded(canvas, actor, person.email);
      }
      // Demotion narrows access; promotion never does — but revalidating is cheap and
      // keeps the rule uniform with removal (R22).
      await revalidate(canvas.id);
      return { ok: true };
    },

    /**
     * Remove an entry: an active person (incl. another editor, or the actor themselves —
     * R8), a pending invitee, a legacy guest (also revoking its sessions), or a team grant.
     * The `owner` entry is owner-only for everyone (R7) — only a transfer changes the owner.
     */
    async remove(
      canvas: Canvas,
      actor: PeopleActor,
      entryId: string,
    ): Promise<PeopleOk | PeopleError> {
      const parsed = parseEntryId(entryId);
      if (parsed.kind === "owner") return ERR.ownerOnly();

      if (parsed.kind === "pending") {
        const cancelled =
          (await deps.invitations?.cancelPendingForTarget(
            "canvas",
            canvas.id,
            parsed.invitationId,
          )) ?? null;
        if (!cancelled) return ERR.notFound();
        deps.audit.recordAudit({
          action: "allowlist_remove",
          actorId: actor.id,
          targetId: canvas.id,
          meta: { entryId, kind: "pending", email: cancelled.email, role: cancelled.role ?? null },
        });
        await revalidate(canvas.id);
        return { ok: true };
      }

      if (parsed.kind === "team") {
        if (!deps.teams) return ERR.notFound();
        const grant = (await deps.teams.listCanvasTeamGrants(canvas.id)).find(
          (g) => g.teamId === parsed.teamId,
        );
        if (!grant || !(await deps.teams.removeCanvasTeam(canvas.id, parsed.teamId))) {
          return ERR.notFound();
        }
        deps.audit.recordAudit({
          action: "allowlist_remove",
          actorId: actor.id,
          targetId: canvas.id,
          meta: { entryId, kind: "team", teamId: parsed.teamId, role: grant.role },
        });
        await revalidate(canvas.id);
        return { ok: true };
      }

      const entry = await resolveRowEntry(canvas, parsed);
      if (!entry) return ERR.notFound();
      if (entry.principalKind === "guest" && entry.email && deps.guests) {
        await deps.guests.revokeInvite(canvas.id, entry.email);
      }
      await deps.canvases.removeAllowlistEntry(canvas.id, entry.id);
      deps.audit.recordAudit({
        action: "allowlist_remove",
        actorId: actor.id,
        targetId: canvas.id,
        meta: {
          entryId,
          kind: entry.principalKind,
          role: entry.role,
          userId: entry.userId,
          email: entry.principalKind === "guest" ? entry.email : null,
        },
      });
      await revalidate(canvas.id);
      return { ok: true };
    },
  };
}

export type PeopleService = ReturnType<typeof peopleService>;

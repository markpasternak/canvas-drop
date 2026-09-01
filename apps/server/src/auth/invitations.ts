import type { AccessRole } from "@canvas-drop/shared/db";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { Logger } from "../log/logger.js";

/** The narrow grant-application surface the materializer needs — the team + canvas repos. */
export interface InvitationApplyDeps {
  invitations: Pick<
    InvitationsRepository,
    "listForEmail" | "consume" | "consumeIfRole" | "findPendingById"
  >;
  teams: { addMember(teamId: string, userId: string): Promise<void> };
  canvases: {
    addAllowlistEntry(input: {
      canvasId: string;
      principalKind: "member" | "guest";
      userId?: string | null;
      email?: string | null;
      role?: AccessRole;
    }): Promise<unknown>;
  };
}

/**
 * Materialize-on-verified-login (plan 003 phase 4 / U4). On a verified login, apply every
 * un-consumed invitation for the verified email — the email is the IdP/proxy identity, never
 * client input. Each grant insert is idempotent (unique index → no-op on a duplicate) and the
 * consume is guarded by `consumed_at IS NULL`, so concurrent logins can't double-apply.
 *
 * Best-effort: a failure to read or apply never blocks the login (the row stays un-consumed and
 * retries on the next login). No app-owned credentials are involved — auth stays delegated to
 * the configured provider.
 */
export async function materializePendingInvitations(
  deps: InvitationApplyDeps,
  user: { id: string; email: string },
  log?: Logger,
): Promise<void> {
  let pending: Awaited<ReturnType<InvitationsRepository["listForEmail"]>>;
  try {
    pending = await deps.invitations.listForEmail(user.email);
  } catch (err) {
    log?.error({ err }, "invitation materialize: listForEmail failed (login unaffected)");
    return;
  }
  for (const first of pending) {
    try {
      if (first.targetType === "team") {
        await deps.teams.addMember(first.targetId, user.id);
        await deps.invitations.consume(first.id);
        continue;
      }
      if (first.targetType !== "canvas") {
        continue; // unknown target_type (DB check should prevent this) — leave un-consumed
      }
      // The invited role rides through (editor-roles plan, KTD2). A legacy null role is
      // a viewer; an omitted role never changes an existing row (KTD3). Whether an
      // editor row is EFFECTIVE is decided live by the role resolver (org membership),
      // so a person who signs in without org membership holds view access only (AE15).
      //
      // Apply-then-consume is role-aware (review #3): the consume only lands while the
      // invite still carries the role we applied. A set-role that changed it in between
      // wins — we re-read and re-apply the latest role (explicitly, so a downgrade takes)
      // before consuming. Bounded: a third change in a row leaves the invite pending for
      // the next login rather than looping.
      let inv = first;
      for (let attempt = 0; attempt < 3; attempt++) {
        const explicitRole = attempt > 0;
        await deps.canvases.addAllowlistEntry({
          canvasId: inv.targetId,
          principalKind: "member",
          userId: user.id,
          ...(inv.role === "editor"
            ? { role: "editor" as const }
            : explicitRole
              ? { role: "viewer" as const }
              : {}),
        });
        if (await deps.invitations.consumeIfRole(inv.id, inv.role ?? null)) break;
        const fresh = await deps.invitations.findPendingById(inv.id);
        if (!fresh) break; // consumed elsewhere — nothing left to apply
        inv = fresh;
      }
    } catch (err) {
      // Leave un-consumed so the next verified login retries; never block the login.
      log?.error({ err, targetType: first.targetType }, "invitation materialize: apply failed");
    }
  }
}

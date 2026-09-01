import type { AccessRole } from "@canvas-drop/shared/db";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { Logger } from "../log/logger.js";

/** The narrow grant-application surface the materializer needs — the team + canvas repos. */
export interface InvitationApplyDeps {
  invitations: Pick<InvitationsRepository, "listForEmail" | "consume">;
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
  for (const inv of pending) {
    try {
      if (inv.targetType === "team") {
        await deps.teams.addMember(inv.targetId, user.id);
      } else if (inv.targetType === "canvas") {
        // The invited role rides through (editor-roles plan, KTD2). A legacy null role is
        // a viewer; an omitted role never changes an existing row (KTD3). Whether an
        // editor row is EFFECTIVE is decided live by the role resolver (org membership),
        // so a person who signs in without org membership holds view access only (AE15).
        await deps.canvases.addAllowlistEntry({
          canvasId: inv.targetId,
          principalKind: "member",
          userId: user.id,
          ...(inv.role === "editor" ? { role: "editor" as const } : {}),
        });
      } else {
        continue; // unknown target_type (DB check should prevent this) — leave un-consumed
      }
      await deps.invitations.consume(inv.id);
    } catch (err) {
      // Leave un-consumed so the next verified login retries; never block the login.
      log?.error({ err, targetType: inv.targetType }, "invitation materialize: apply failed");
    }
  }
}

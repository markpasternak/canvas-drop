import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { Logger } from "../log/logger.js";

/** The narrow grant-application surface the materializer needs — the team + canvas repos. */
export interface InvitationApplyDeps {
  invitations: Pick<
    InvitationsRepository,
    "listForEmail" | "materializeCanvasGrant" | "materializeTeamGrant" | "findPendingById"
  >;
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
        await deps.invitations.materializeTeamGrant({
          invitationId: first.id,
          teamId: first.targetId,
          userId: user.id,
        });
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
      // Claim-and-apply is role-aware and atomic: a set-role or cancellation that lands
      // before the conditional claim wins. We re-read a role mismatch and apply the
      // latest role explicitly (so a downgrade takes). Bounded: a third change in a row
      // leaves the invite pending for the next login rather than looping.
      let inv = first;
      for (let attempt = 0; attempt < 3; attempt++) {
        const explicitRole = attempt > 0;
        const applied = await deps.invitations.materializeCanvasGrant({
          invitationId: inv.id,
          canvasId: inv.targetId,
          userId: user.id,
          expectedRole: inv.role ?? null,
          role: inv.role === "editor" ? "editor" : "viewer",
          updateExistingRole: inv.role === "editor" || explicitRole,
        });
        if (applied) break;
        const fresh = await deps.invitations.findPendingById(inv.id);
        if (!fresh) break; // cancelled or consumed elsewhere — no grant may be applied
        inv = fresh;
      }
    } catch (err) {
      // Leave un-consumed so the next verified login retries; never block the login.
      log?.error({ err, targetType: first.targetType }, "invitation materialize: apply failed");
    }
  }
}

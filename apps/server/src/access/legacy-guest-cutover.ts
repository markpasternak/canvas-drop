import type { Config } from "@canvas-drop/shared";
import type { CanvasAllowlistEntry, GuestInvite } from "@canvas-drop/shared/db";
import { isEmailDomainAllowed } from "../auth/identity-mapping.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { GuestRepository } from "../db/repositories/guest.js";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { Logger } from "../log/logger.js";

export interface LegacyGuestCutoverReport {
  considered: number;
  convertedToMembers: number;
  convertedToPending: number;
  permitsAdded: number;
  manualActionRequired: Array<{ canvasId: string; email: string; reason: string }>;
  removedGuestAllowlistRows: number;
  revokedCredentials: boolean;
}

export interface LegacyGuestCutoverDeps {
  config: Config;
  users: Pick<UsersRepository, "findByEmail">;
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed" | "add">;
  invitations: Pick<InvitationsRepository, "record">;
  canvases: Pick<
    CanvasesRepository,
    "findById" | "addAllowlistEntry" | "removeAllowlistEntry" | "listGuestAllowlistEntries"
  >;
  guests: Pick<GuestRepository, "listNonRevokedInvites" | "revokeAllInvitesAndSessions">;
  log?: Logger;
}

interface LegacyGuestTarget {
  canvasId: string;
  email: string;
  allowlistEntryIds: Set<string>;
}

function normalizeEmail(email: string | null): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized?.includes("@") ? normalized : null;
}

function key(canvasId: string, email: string): string {
  return `${canvasId}\0${email}`;
}

function mergeAllowlistRows(targets: Map<string, LegacyGuestTarget>, rows: CanvasAllowlistEntry[]) {
  for (const row of rows) {
    const email = normalizeEmail(row.email);
    if (!email) continue;
    const k = key(row.canvasId, email);
    const existing = targets.get(k);
    if (existing) {
      existing.allowlistEntryIds.add(row.id);
    } else {
      targets.set(k, { canvasId: row.canvasId, email, allowlistEntryIds: new Set([row.id]) });
    }
  }
}

function mergeInvites(targets: Map<string, LegacyGuestTarget>, invites: GuestInvite[]) {
  for (const invite of invites) {
    const email = normalizeEmail(invite.email);
    if (!email) continue;
    const k = key(invite.canvasId, email);
    if (!targets.has(k)) {
      targets.set(k, { canvasId: invite.canvasId, email, allowlistEntryIds: new Set() });
    }
  }
}

async function removeLegacyAllowlistRows(
  deps: LegacyGuestCutoverDeps,
  target: LegacyGuestTarget,
): Promise<number> {
  let removed = 0;
  for (const id of target.allowlistEntryIds) {
    await deps.canvases.removeAllowlistEntry(target.canvasId, id);
    removed += 1;
  }
  return removed;
}

/**
 * Convert old canvas-scoped guest grants into auth-delegated access. This is an
 * idempotent boot/ops cutover: successful conversions remove the legacy allowlist
 * row, pending rows use the existing unique key, and all magic-link credentials
 * are revoked at the end so stale cookies/tokens are inert.
 */
export async function runLegacyGuestCutover(
  deps: LegacyGuestCutoverDeps,
): Promise<LegacyGuestCutoverReport> {
  const targets = new Map<string, LegacyGuestTarget>();
  mergeAllowlistRows(targets, await deps.canvases.listGuestAllowlistEntries());
  mergeInvites(targets, await deps.guests.listNonRevokedInvites());

  const report: LegacyGuestCutoverReport = {
    considered: targets.size,
    convertedToMembers: 0,
    convertedToPending: 0,
    permitsAdded: 0,
    manualActionRequired: [],
    removedGuestAllowlistRows: 0,
    revokedCredentials: false,
  };

  for (const target of targets.values()) {
    const canvas = await deps.canvases.findById(target.canvasId);
    if (!canvas || canvas.status === "deleted") {
      report.manualActionRequired.push({
        canvasId: target.canvasId,
        email: target.email,
        reason: "missing_or_deleted_canvas",
      });
      continue;
    }

    const user = await deps.users.findByEmail(target.email);
    if (user) {
      if (user.isBlocked) {
        report.manualActionRequired.push({
          canvasId: target.canvasId,
          email: target.email,
          reason: "matched_user_blocked",
        });
        continue;
      }
      await deps.canvases.addAllowlistEntry({
        canvasId: target.canvasId,
        principalKind: "member",
        userId: user.id,
      });
      report.convertedToMembers += 1;
      report.removedGuestAllowlistRows += await removeLegacyAllowlistRows(deps, target);
      continue;
    }

    const domainAllowed = isEmailDomainAllowed(target.email, deps.config);
    const permitExists = domainAllowed || (await deps.allowedEmails.isAllowed(target.email));
    if (deps.config.auth.mode === "proxy" && !permitExists) {
      report.manualActionRequired.push({
        canvasId: target.canvasId,
        email: target.email,
        reason: "proxy_admission_required",
      });
      continue;
    }

    if (!permitExists) {
      await deps.allowedEmails.add(target.email, canvas.ownerId);
      report.permitsAdded += 1;
    }
    await deps.invitations.record({
      email: target.email,
      target: { type: "canvas", id: target.canvasId },
      invitedBy: canvas.ownerId,
    });
    report.convertedToPending += 1;
    report.removedGuestAllowlistRows += await removeLegacyAllowlistRows(deps, target);
  }

  if (report.considered > 0) {
    await deps.guests.revokeAllInvitesAndSessions();
    report.revokedCredentials = true;
    deps.log?.info(report, "legacy guest cutover completed");
  }

  return report;
}

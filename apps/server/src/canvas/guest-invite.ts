import type { Config } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import type { GuestService } from "../auth/guest.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import { type Mailer, renderGuestInvite } from "../email/mailer.js";

/** A guard failure carries a stable code + an HTTP-ish status the caller maps to its
 *  own envelope (the management route → c.json; the MCP tool → a `CODE: message` fail). */
export type InviteResult =
  | { ok: true }
  | { ok: false; code: string; message: string; status: 409 | 502 };

export interface InviteGuestDeps {
  config: Config;
  canvases: Pick<CanvasesRepository, "addAllowlistEntry">;
  /** Guest magic-link service — absent in proxy mode, where invites are refused. */
  guests?: GuestService;
  mailer?: Mailer;
  audit: AuditLog;
}

/**
 * Mint + email a guest invite and add the guest allowlist grant. The single
 * implementation behind the management `POST /:id/allowlist` route and the MCP
 * `invite_guest` / `resend_guest_invite` tools, so the two can't diverge on the
 * proxy-mode / email-config refusals or the persist-before-send ordering.
 *
 * Persists the allowlist grant + invite BEFORE sending, so the email send is the last
 * fallible step: a send failure leaves a consistent, resend-able state (pending invite
 * + grant) rather than a delivered magic link with no grant behind it. Both writes are
 * idempotent upserts, so a resend is safe.
 */
export async function inviteGuestToCanvas(
  deps: InviteGuestDeps,
  args: { canvas: Canvas; inviterName: string; actorId: string; email: string },
): Promise<InviteResult> {
  const { canvas, inviterName, actorId, email } = args;
  // Guest invites are an app-gated-mode capability (R22): in proxy mode the IAP owns
  // the boundary and `guests` is absent.
  if (deps.config.auth.mode === "proxy" || !deps.guests) {
    return {
      ok: false,
      code: "GUESTS_UNAVAILABLE",
      message: "Guest invites need the app to manage sign-in (oidc/dev mode).",
      status: 409,
    };
  }
  if (!deps.mailer?.canSend) {
    return {
      ok: false,
      code: "EMAIL_NOT_CONFIGURED",
      message: "Email isn't configured, so invites can't send.",
      status: 409,
    };
  }
  await deps.canvases.addAllowlistEntry({ canvasId: canvas.id, principalKind: "guest", email });
  const { token } = await deps.guests.createInvite(canvas.id, email);
  const inviteUrl = new URL(`/guest/${encodeURIComponent(token)}`, deps.config.baseUrl).toString();
  const msg = renderGuestInvite({ canvasTitle: canvas.title, inviterName, inviteUrl });
  const sent = await deps.mailer.send({ ...msg, to: email });
  if (!sent.ok) {
    return {
      ok: false,
      code: "EMAIL_SEND_FAILED",
      message: "Couldn't send the invite email.",
      status: 502,
    };
  }
  deps.audit.recordAudit({ action: "guest_invite", actorId, targetId: canvas.id, meta: { email } });
  return { ok: true };
}

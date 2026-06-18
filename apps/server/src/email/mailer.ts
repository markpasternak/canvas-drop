/**
 * Email abstraction (U5) — driver-behind-interface like DB/storage/auth. Used by
 * the guest-invite flow (U8) to send magic-link sign-in emails. Four drivers:
 * `mailgun` (HTTP API), `smtp` (any SMTP server), `log` (dev — records the
 * envelope only, never the magic-link body), and `noop` (discards). The driver is
 * config-selected; `config` stays the only `process.env` reader (BUILD_BRIEF §8.1).
 *
 * Sending must never throw — a transport failure returns `{ ok: false, error }`
 * so the invite flow surfaces it without crashing the request.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export interface Mailer {
  /** Send one message. Resolves `{ ok: false, error }` on failure — never throws. */
  send(msg: EmailMessage): Promise<SendResult>;
  /**
   * Whether the invite flow can actually deliver a usable link. True for `mailgun`
   * and `smtp` when configured (a real send) and `log` (dev — the link reaches the
   * caller directly); false for `noop` or an unconfigured driver. The invite flow
   * checks this to refuse cleanly when email is off.
   */
  readonly canSend: boolean;
}

/** Minimal escape so a title/name can't break out of the HTML email body. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The guest-invite magic-link email (U5/U8). Plain shape so it renders in any
 * client; the link is the credential — single-use, expiring (U6). Kept here so
 * the template has one home and the invite flow just fills the fields.
 */
export function renderGuestInvite(input: {
  canvasTitle: string;
  inviterName: string;
  inviteUrl: string;
}): Omit<EmailMessage, "to"> {
  const title = input.canvasTitle.trim() || "a canvas";
  const subject = `${input.inviterName} shared "${title}" with you`;
  const text = [
    `${input.inviterName} invited you to view "${title}".`,
    "",
    `Open it here (this link is just for you and will expire):`,
    input.inviteUrl,
    "",
    "If you weren't expecting this, you can ignore this email.",
  ].join("\n");
  const html = [
    `<p>${esc(input.inviterName)} invited you to view <strong>${esc(title)}</strong>.</p>`,
    `<p><a href="${esc(input.inviteUrl)}">Open the canvas</a> — this link is just for you and will expire.</p>`,
    `<p style="color:#888;font-size:12px">If you weren't expecting this, you can ignore this email.</p>`,
  ].join("\n");
  // `to` is intentionally omitted: the caller fills it (`{ ...msg, to: email }`).
  // Omitting it from the type makes forgetting the recipient a compile error.
  return { subject, text, html };
}

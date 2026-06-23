/**
 * Email abstraction (U5) — driver-behind-interface like DB/storage/auth. Used by
 * auth-delegated invite and notification flows. Four drivers: `mailgun` (HTTP
 * API), `smtp` (any SMTP server), `log` (dev — records the envelope only, never
 * the body), and `noop` (discards). The driver is config-selected; `config` stays
 * the only `process.env` reader (BUILD_BRIEF §8.1).
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
   * Whether invite/notification flows can actually deliver email. True for
   * `mailgun` and `smtp` when configured and for `log` in dev; false for `noop`
   * or an unconfigured driver. Callers check this to refuse cleanly when email is
   * required but off.
   */
  readonly canSend: boolean;
}

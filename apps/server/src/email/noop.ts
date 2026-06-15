import type { Mailer } from "./mailer.js";

/**
 * Noop mailer (U5): discards every message. `canSend` is false so the invite flow
 * refuses cleanly ("email isn't configured") rather than silently dropping invites.
 */
export function noopMailer(): Mailer {
  return {
    canSend: false,
    async send() {
      return { ok: false, error: "email_disabled" };
    },
  };
}

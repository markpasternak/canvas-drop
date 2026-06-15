import type { Logger } from "../log/logger.js";
import type { EmailMessage, Mailer } from "./mailer.js";

/**
 * Dev mailer (U5): writes the message — including the magic link in the body — to
 * the logger so localhost needs no email setup. `canSend` is true because the link
 * is usable from the console. Never used in production (the operator picks
 * `mailgun` or `noop`).
 */
export function logMailer(log: Logger): Mailer {
  return {
    canSend: true,
    async send(msg: EmailMessage) {
      log.info({ to: msg.to, subject: msg.subject, body: msg.text }, "email (log driver)");
      return { ok: true };
    },
  };
}

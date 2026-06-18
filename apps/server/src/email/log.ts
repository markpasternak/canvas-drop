import type { Logger } from "../log/logger.js";
import type { EmailMessage, Mailer } from "./mailer.js";

/**
 * Dev mailer (U5): records that an email would be sent so localhost needs no email
 * setup. `canSend` is true because dev auth/invite flows surface the link to the
 * caller directly. Intended for dev only (the operator picks `mailgun`/`smtp` in
 * production); see the boot warning in config when `log` runs under NODE_ENV=production.
 *
 * The body is NEVER logged: it carries the one-time magic-link credential, and the
 * `log` driver writes to stdout that any aggregator captures. Log only the envelope
 * (`to`, `subject`) so a credential can never leak into the log stream.
 */
export function logMailer(log: Logger): Mailer {
  return {
    canSend: true,
    async send(msg: EmailMessage) {
      log.info({ to: msg.to, subject: msg.subject }, "email (log driver)");
      return { ok: true };
    },
  };
}

import type { Config } from "@canvas-drop/shared";
import type { Logger } from "../log/logger.js";
import { logMailer } from "./log.js";
import type { Mailer } from "./mailer.js";
import { mailgunMailer } from "./mailgun.js";
import { noopMailer } from "./noop.js";
import { smtpMailer } from "./smtp.js";

/**
 * Build the configured mailer (U5, KTD6). `log` → dev console driver; `smtp` →
 * any SMTP server; `mailgun` → the HTTP API driver; `noop` → discards. Mirrors the
 * DB/storage/auth factories: swapping the transport is a config change, not a code
 * change — adding a future API provider is a new driver file + a case here.
 */
export function setupMailer(config: Config, log: Logger): Mailer {
  const driver = config.email.driver;
  switch (driver) {
    case "smtp":
      return smtpMailer(config.email, config.email.from, log);
    case "mailgun":
      return mailgunMailer(config.email, config.email.from, log);
    case "noop":
      return noopMailer();
    case "log":
      return logMailer(log);
    default: {
      // Exhaustiveness: a new driver added to the config enum without a case here
      // is a compile error (never a silent fall-through to the token-logging driver).
      const _exhaustive: never = driver;
      throw new Error(`unknown email driver: ${String(_exhaustive)}`);
    }
  }
}

export type { Mailer } from "./mailer.js";

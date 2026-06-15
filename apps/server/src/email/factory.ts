import type { Config } from "@canvas-drop/shared";
import type { Logger } from "../log/logger.js";
import { logMailer } from "./log.js";
import type { Mailer } from "./mailer.js";
import { mailgunMailer } from "./mailgun.js";
import { noopMailer } from "./noop.js";

/**
 * Build the configured mailer (U5, KTD6). `log` → dev console driver; `mailgun` →
 * the HTTP API driver; `noop` → discards. Mirrors the DB/storage/auth factories:
 * swapping the transport is a config change, not a code change.
 */
export function setupMailer(config: Config, log: Logger): Mailer {
  switch (config.email.driver) {
    case "mailgun":
      return mailgunMailer(config.email, config.email.from, log);
    case "noop":
      return noopMailer();
    default:
      return logMailer(log);
  }
}

export type { Mailer } from "./mailer.js";

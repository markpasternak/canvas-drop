import type { Config } from "@canvas-drop/shared";
import nodemailer, { type Transporter } from "nodemailer";
import type { Logger } from "../log/logger.js";
import type { EmailMessage, Mailer, SendResult } from "./mailer.js";

/**
 * SMTP driver (U5/U8) — sends via any SMTP server using nodemailer. Credentials
 * are env-only and never logged. `secure` is implicit TLS (port 465); otherwise
 * STARTTLS is negotiated (port 587). Configured = a host is set; auth is included
 * only when a user/pass pair is present (some relays are IP-allowlisted). Failures
 * return `{ ok: false, error }` rather than throwing.
 */
export function smtpMailer(cfg: Config["email"], from: string, log?: Logger): Mailer {
  const { host, port, user, pass, secure } = cfg.smtp;
  const configured = Boolean(host);
  // Build the transporter lazily so an unconfigured driver constructs cleanly.
  let transport: Transporter | undefined;
  const transporter = (): Transporter => {
    if (!transport) {
      transport = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user && pass ? { user, pass } : undefined,
        // Bound the send so a stuck SMTP server can't hang the invite handler for
        // nodemailer's 10-minute default socket timeout.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
    }
    return transport;
  };

  return {
    canSend: configured,
    async send(msg: EmailMessage): Promise<SendResult> {
      if (!configured) return { ok: false, error: "smtp_not_configured" };
      try {
        await transporter().sendMail({
          from,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        });
        return { ok: true };
      } catch (err) {
        log?.error({ err: (err as Error).message }, "smtp send failed");
        return { ok: false, error: "smtp_send_failed" };
      }
    },
  };
}

import type { Config } from "@canvas-drop/shared";
import type { Logger } from "../log/logger.js";
import type { EmailMessage, Mailer, SendResult } from "./mailer.js";

/**
 * Mailgun HTTP API driver (U5). POSTs form-encoded messages to
 * `${baseUrl}/v3/${domain}/messages` with HTTP Basic auth (`api:<key>`). The API
 * key is env-only (never DB-overridable, never logged) since invite emails are
 * auth credentials. Failures return `{ ok: false, error }` rather than throwing.
 */
export function mailgunMailer(cfg: Config["email"], from: string, log?: Logger): Mailer {
  const { apiKey, domain, baseUrl } = cfg.mailgun;
  const configured = Boolean(apiKey && domain);
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v3/${domain}/messages`;
  const auth = `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`;

  return {
    canSend: configured,
    async send(msg: EmailMessage): Promise<SendResult> {
      if (!configured) {
        return { ok: false, error: "mailgun_not_configured" };
      }
      const body = new URLSearchParams({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
      });
      if (msg.html) body.set("html", msg.html);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
          body,
          // Bound the call so a slow/unreachable Mailgun can't hang the invite
          // request handler; an AbortError is caught below as `mailgun_unreachable`.
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          // Status only — never log the response body or the key.
          log?.error({ status: res.status }, "mailgun send failed");
          return { ok: false, error: `mailgun_status_${res.status}` };
        }
        return { ok: true };
      } catch (err) {
        log?.error({ err: (err as Error).message }, "mailgun send threw");
        return { ok: false, error: "mailgun_unreachable" };
      }
    },
  };
}

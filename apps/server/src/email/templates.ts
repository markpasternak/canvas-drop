import type { EmailTemplatesRepository, TemplateBody } from "../db/repositories/email-templates.js";
import type { EmailMessage } from "./mailer.js";

/**
 * Email templates (plan 003 phase 3). Each invite/notification email is one keyed template
 * with a seeded default that an admin may override (subject + HTML + text). Bodies use an
 * **allow-listed `{{variable}}`** interpolator: values are HTML-escaped in the HTML body,
 * substituted raw in the text body + subject, and an unknown `{{var}}` renders empty (defined,
 * never a throw). No arbitrary expressions — substitution only.
 *
 * Copy is **org-agnostic** (no hardcoded instance domain); the instance name + links are
 * passed in as variables.
 */

export type TemplateKey =
  | "account_invite"
  | "canvas_invite"
  | "individual_canvas_invite"
  | "team_invite";

/** The variables a caller may supply (the allow-list — any `{{var}}` outside this set, or
 *  absent from the supplied map, renders empty). */
export type TemplateVars = Partial<
  Record<
    | "name"
    | "inviterName"
    | "instanceName"
    | "orgName"
    | "orgContext"
    | "canvasTitle"
    | "teamName"
    | "link",
    string
  >
>;

export const TEMPLATE_KEYS: readonly TemplateKey[] = [
  "account_invite",
  "canvas_invite",
  "individual_canvas_invite",
  "team_invite",
];

const html = (subject: string, lead: string, cta: string): string =>
  `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px">` +
  `<h1 style="font-size:18px;margin:0 0 12px">${subject}</h1>` +
  `<p style="font-size:14px;line-height:1.5;color:#333">${lead}</p>` +
  `<p style="margin:20px 0"><a href="{{link}}" style="background:#0a7;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-size:14px">${cta}</a></p>` +
  `<p style="font-size:12px;color:#888">If the button doesn't work, open: {{link}}</p>` +
  `</div>`;

/** Seeded defaults from before the auth-delegated access cleanup. Used only for safe rollout:
 *  rows that still exactly match one of these boot-seeded bodies can be migrated to the new
 *  defaults; admin-customized rows are preserved. */
export const PREVIOUS_DEFAULT_TEMPLATES: readonly Record<TemplateKey, TemplateBody>[] = [
  {
    account_invite: {
      subject: "You've been invited to {{instanceName}}",
      bodyHtml: html(
        "You've been invited to {{instanceName}}",
        "{{inviterName}} added you to {{instanceName}}. Sign in to get started.",
        "Sign in",
      ),
      bodyText:
        "{{inviterName}} added you to {{instanceName}}. Sign in to get started:\n\n{{link}}\n",
    },
    canvas_invite: {
      subject: "{{inviterName}} shared “{{canvasTitle}}” with you",
      bodyHtml: html(
        "A canvas was shared with you",
        "{{inviterName}} gave you access to “{{canvasTitle}}” on {{instanceName}}. Sign in to open it.",
        "Open canvas",
      ),
      bodyText:
        "{{inviterName}} gave you access to “{{canvasTitle}}” on {{instanceName}}. Sign in to open it:\n\n{{link}}\n",
    },
    individual_canvas_invite: {
      subject: "{{inviterName}} invited you to “{{canvasTitle}}”",
      bodyHtml: html(
        "You're invited to a canvas",
        "{{inviterName}} invited you to “{{canvasTitle}}” on {{instanceName}}.",
        "Open canvas",
      ),
      bodyText:
        "{{inviterName}} invited you to “{{canvasTitle}}” on {{instanceName}}:\n\n{{link}}\n",
    },
    team_invite: {
      subject: "You've been added to the team “{{teamName}}”",
      bodyHtml: html(
        "Added to a team",
        "{{inviterName}} added you to the team “{{teamName}}” on {{instanceName}}. Canvases shared with that team are now available to you.",
        "Open {{instanceName}}",
      ),
      bodyText:
        "{{inviterName}} added you to the team “{{teamName}}” on {{instanceName}}. Sign in to see what's shared:\n\n{{link}}\n",
    },
  },
];

/** The seeded defaults. Subjects are plain; bodies use `{{variable}}`. */
export const DEFAULT_TEMPLATES: Record<TemplateKey, TemplateBody> = {
  account_invite: {
    subject: "You've been invited to {{instanceName}}",
    bodyHtml: html(
      "You've been invited to {{instanceName}}",
      "{{inviterName}} invited you to sign in to {{instanceName}}{{orgContext}}. Use this email address to get started.",
      "Sign in",
    ),
    bodyText:
      "{{inviterName}} invited you to sign in to {{instanceName}}{{orgContext}}. Use this email address to get started:\n\n{{link}}\n",
  },
  canvas_invite: {
    subject: "{{inviterName}} shared the canvas “{{canvasTitle}}” with you",
    bodyHtml: html(
      "A canvas was shared with you",
      "{{inviterName}} granted you access to the canvas “{{canvasTitle}}” on {{instanceName}}. Sign in with this email address to open it.",
      "Open canvas",
    ),
    bodyText:
      "{{inviterName}} granted you access to the canvas “{{canvasTitle}}” on {{instanceName}}. Sign in with this email address to open it:\n\n{{link}}\n",
  },
  individual_canvas_invite: {
    subject: "{{inviterName}} invited you to “{{canvasTitle}}”",
    bodyHtml: html(
      "You're invited to a canvas",
      "{{inviterName}} granted you access to the canvas “{{canvasTitle}}” on {{instanceName}}.",
      "Open canvas",
    ),
    bodyText:
      "{{inviterName}} granted you access to the canvas “{{canvasTitle}}” on {{instanceName}}:\n\n{{link}}\n",
  },
  team_invite: {
    subject: "You've been added to the team “{{teamName}}”",
    bodyHtml: html(
      "Added to a team",
      "{{inviterName}} granted you access to the team “{{teamName}}” on {{instanceName}}. Canvases shared with that team are now available to you.",
      "Open {{instanceName}}",
    ),
    bodyText:
      "{{inviterName}} granted you access to the team “{{teamName}}” on {{instanceName}}. Sign in to see what's shared:\n\n{{link}}\n",
  },
};

/** HTML-escape a value so it can't break out of an attribute/text node in the HTML body. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Substitute `{{var}}` (optional inner whitespace) from `vars`; unknown/absent → empty.
 *  `asHtml` true HTML-escapes each value (for the HTML body). */
function interpolate(template: string, vars: TemplateVars, asHtml: boolean): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, varName: string) => {
    const v = (vars as Record<string, string | undefined>)[varName];
    if (v == null) return "";
    return asHtml ? escapeHtml(v) : v;
  });
}

/** Render a template body + vars into an `EmailMessage` for `to`. */
export function renderTemplate(body: TemplateBody, to: string, vars: TemplateVars): EmailMessage {
  return {
    to,
    subject: interpolate(body.subject, vars, false),
    text: interpolate(body.bodyText, vars, false),
    html: interpolate(body.bodyHtml, vars, true),
  };
}

/** Idempotently seed the default templates at boot (no-op for keys that already have a row). */
export async function seedDefaultTemplates(repo: EmailTemplatesRepository): Promise<void> {
  await repo.seedDefaults(DEFAULT_TEMPLATES, PREVIOUS_DEFAULT_TEMPLATES);
}

/** Resolve a template's effective body: the admin override if present, else the seeded default
 *  (defensive — a missing row falls back to the default rather than failing the send). */
export async function effectiveTemplate(
  repo: Pick<EmailTemplatesRepository, "get">,
  key: TemplateKey,
): Promise<TemplateBody> {
  const row = await repo.get(key);
  return row
    ? { subject: row.subject, bodyHtml: row.bodyHtml, bodyText: row.bodyText }
    : DEFAULT_TEMPLATES[key];
}

import type { Config } from "@canvas-drop/shared";
import { adminSettingsService } from "../admin/settings-service.js";
import type { DbClient } from "../db/factory.js";
import { allowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { emailTemplatesRepository } from "../db/repositories/email-templates.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { settingsRepository } from "../db/repositories/settings.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { noopMailer } from "../email/noop.js";
import { inProcessRateLimitStore } from "../http/rate-limit.js";
import { type InviteService, inviteService } from "./service.js";

/**
 * Build a real {@link InviteService} over a test DB (plan 003 U5/U6). Wires the real repos +
 * settings service over `client`, with a noop mailer (no courtesy mail in tests) and a fresh
 * in-process rate-limit store. Used by the team/MCP/integration harnesses so the invite path is
 * the real one, not a stub.
 */
export function makeInviteService(client: DbClient, config: Config): InviteService {
  return inviteService({
    config,
    users: usersRepository(client),
    allowedEmails: allowedEmailsRepository(client),
    invitations: invitationsRepository(client),
    teams: teamsRepository(client),
    canvases: canvasesRepository(client),
    settings: adminSettingsService({ settings: settingsRepository(client), config }),
    templates: emailTemplatesRepository(client),
    mailer: noopMailer(),
    rateLimitStore: inProcessRateLimitStore(),
  });
}

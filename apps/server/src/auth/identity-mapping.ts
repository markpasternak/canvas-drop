import type { Config } from "@canvas-drop/shared";
import type { User } from "@canvas-drop/shared/db";
import type { UsersRepository } from "../db/repositories/users.js";
import type { ResolvedIdentity } from "./strategy.js";

/** Whether an email's domain is in the configured allowlist (enforced every request). */
export function isEmailDomainAllowed(email: string, config: Config): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return config.auth.allowedEmailDomains.includes(domain);
}

/** Whether an email is a bootstrap admin (CANVAS_DROP_ADMIN_EMAILS, D14). */
export function isAdminEmail(email: string, config: Config): boolean {
  return config.adminEmails.includes(email.toLowerCase());
}

/**
 * Map a resolved identity to a `users` row: upsert by provider subject, applying
 * the admin bootstrap. Mutable identity fields and `last_seen_at` are refreshed
 * on every call; `is_blocked` is never reset here.
 */
export async function mapIdentityToUser(
  users: UsersRepository,
  identity: ResolvedIdentity,
  config: Config,
): Promise<User> {
  return users.upsert({
    providerSub: identity.sub,
    email: identity.email.toLowerCase(),
    name: identity.name ?? identity.email,
    avatarUrl: identity.avatarUrl ?? null,
    isAdmin: isAdminEmail(identity.email, config),
  });
}

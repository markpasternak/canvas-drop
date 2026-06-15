import type { Config } from "@canvas-drop/shared";
import type { User } from "@canvas-drop/shared/db";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { ResolvedIdentity } from "./strategy.js";

/**
 * Derive a {@link ResolvedIdentity} from a claims object (OIDC ID-token claims
 * or a verified proxy JWT payload), namespacing the subject by trust source so
 * identities from different auth modes never collide on `provider_sub`. Shared
 * by the proxy and oidc strategies so the extraction + prefixing stay in lockstep.
 */
export function claimsToIdentity(
  claims: Record<string, unknown>,
  subPrefix: string,
): ResolvedIdentity | null {
  const email = typeof claims.email === "string" ? claims.email : undefined;
  if (!email) return null;
  const rawSub = typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : email;
  const name = typeof claims.name === "string" ? claims.name : undefined;
  const avatarUrl = typeof claims.picture === "string" ? claims.picture : undefined;
  return { sub: `${subPrefix}:${rawSub}`, email, name, avatarUrl };
}

/** Whether an email's domain is in the configured allowlist (enforced every request). */
export function isEmailDomainAllowed(email: string, config: Config): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return config.auth.allowedEmailDomains.includes(domain);
}

/**
 * Whether an email may sign in: its domain is in the env allowlist (D14), OR it is
 * an admin-added individual email (the DB allowlist supplement). The DB lookup only
 * fires when the domain check fails, so the hot path stays a synchronous array check.
 */
export async function isEmailAllowed(
  email: string,
  config: Config,
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">,
): Promise<boolean> {
  if (isEmailDomainAllowed(email, config)) return true;
  return allowedEmails.isAllowed(email);
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

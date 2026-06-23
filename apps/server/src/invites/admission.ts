import type { Config } from "@canvas-drop/shared";
import { isEmailDomainAllowed } from "../auth/identity-mapping.js";
import type { AllowedEmailsRepository } from "../db/repositories/allowed-emails.js";

export type NewEmailAdmission =
  | { status: "permitted"; alreadyAuthenticates: boolean }
  | { status: "policy_blocked"; alreadyAuthenticates: boolean }
  | { status: "auth_admission_required"; alreadyAuthenticates: false };

export interface ResolveNewEmailAdmissionInput {
  config: Config;
  email: string;
  /** Whether this action may create a new app-managed sign-in permit when needed. */
  canCreatePermit: boolean;
  allowedEmails: Pick<AllowedEmailsRepository, "isAllowed">;
}

/**
 * Shared KTD5 admission decision for brand-new emails. It distinguishes two facts:
 * whether the email can already sign in, and whether this caller/operation may create
 * a new app-managed sign-in permit. Proxy/IAP mode is stricter: canvas-drop cannot
 * create an upstream admission rule, so an unknown email needs external setup first.
 */
export async function resolveNewEmailAdmission({
  config,
  email,
  canCreatePermit,
  allowedEmails,
}: ResolveNewEmailAdmissionInput): Promise<NewEmailAdmission> {
  const alreadyAuthenticates =
    isEmailDomainAllowed(email, config) || (await allowedEmails.isAllowed(email));

  if (config.auth.mode === "proxy" && !alreadyAuthenticates) {
    return { status: "auth_admission_required", alreadyAuthenticates: false };
  }

  if (!canCreatePermit && !alreadyAuthenticates) {
    return { status: "policy_blocked", alreadyAuthenticates };
  }

  return { status: "permitted", alreadyAuthenticates };
}

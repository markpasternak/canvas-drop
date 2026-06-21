import { domainOfEmail } from "@canvas-drop/shared";
import type { OrgsRepository } from "../db/repositories/orgs.js";

/**
 * Server-side org-membership classifier (plan 002 U3, KTD2 — the member/guest boundary).
 *
 * Membership is DERIVED from the caller's verified email domain: the org whose configured
 * domains contain that domain (exact, normalized). It is **independent of**
 * `allowed_emails` / `ADMIN_EMAILS` — those grant *sign-in*, not membership, so an
 * allowlisted Gmail user or an admin on a non-org domain resolves to ∅ (a guest). A user
 * whose domain matches no org → ∅.
 *
 * Injected (a function, not a method) so Phase 2 can swap the body for `derived ∪ explicit`
 * (team/org_members) with zero changes at any call site. NEVER reads anything the client
 * sends — the email comes from the server-resolved user row.
 */
export type OrgMembershipResolver = (user: { email: string }) => Promise<Set<string>>;

export function makeOrgMembershipResolver(
  orgs: Pick<OrgsRepository, "findByDomain">,
): OrgMembershipResolver {
  return async (user) => {
    const domain = domainOfEmail(user.email);
    if (!domain) return new Set();
    const org = await orgs.findByDomain(domain);
    return org ? new Set([org.id]) : new Set();
  };
}

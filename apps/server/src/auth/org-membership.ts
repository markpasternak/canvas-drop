import { domainOfEmail } from "@canvas-drop/shared";
import type { OrgMembersRepository } from "../db/repositories/org-members.js";
import type { OrgsRepository } from "../db/repositories/orgs.js";

/**
 * Server-side org-membership classifier (plan 002 U3 / plan 003 U2, KTD1/KTD2 — the
 * member/guest boundary).
 *
 * Membership is DERIVED from the caller's verified email domain: the org whose configured
 * domains contain that domain (exact, normalized). It is **independent of**
 * `allowed_emails` / `ADMIN_EMAILS` — those grant *sign-in*, not membership, so an
 * allowlisted Gmail user or an admin on a non-org domain resolves to ∅ (a guest).
 *
 * **P2 (teams):** the resolver now also MATERIALIZES the membership as a `source='domain'`
 * `org_members` row (idempotent) so the roster + team checks have a join target. The
 * RETURNED set stays the LIVE derived membership (not the materialized table), so a stale
 * row from a removed domain never widens access — the resolver is the real-time boundary;
 * `reconcile` only tidies the table. The set is `derived ∪ {valid explicit}`; P2's only
 * explicit source is `'domain'` (≡ derived), so the union is just `derived` today — a P4
 * invite source would union its still-valid rows here.
 *
 * NEVER reads anything the client sends — the email/id come from the server-resolved row.
 */
export type OrgMembershipResolver = (user: { id: string; email: string }) => Promise<Set<string>>;

export function makeOrgMembershipResolver(
  orgs: Pick<OrgsRepository, "findByDomain">,
  orgMembers: Pick<OrgMembersRepository, "upsertDomainMember">,
): OrgMembershipResolver {
  return async (user) => {
    const domain = domainOfEmail(user.email);
    const derived = domain ? await orgs.findByDomain(domain) : null;
    const ids = new Set<string>();
    if (derived) {
      ids.add(derived.id);
      // Materialize the membership row for the roster + team joins (idempotent). The
      // returned `ids` is the LIVE derived set, so this side-effect never affects the
      // real-time boundary.
      await orgMembers.upsertDomainMember(derived.id, user.id);
    }
    return ids;
  };
}

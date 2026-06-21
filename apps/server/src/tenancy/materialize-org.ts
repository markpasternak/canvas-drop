import { type Config, orgSlug } from "@canvas-drop/shared";
import type { OrgsRepository } from "../db/repositories/orgs.js";
import type { Logger } from "../log/logger.js";

/**
 * Materialize the single configured org at boot (plan 002 U2/KTD4).
 *
 * No-op when no org is named (tenancy inert — `whole_org` keeps its legacy "any signed-in
 * user" meaning). Otherwise it idempotently upserts the org + its domains, then enforces
 * the P1 invariant of exactly one org. It fails LOUD (throws) on bad config — a domain
 * mapped to two orgs (caught in the repo) or more than one org row — so a misconfiguration
 * can never silently mis-scope the authorization boundary. Mirrors the admin-email
 * reconciliation: awaited before the server serves, not best-effort.
 */
export async function materializeOrg(deps: {
  config: Config;
  orgs: OrgsRepository;
  log: Logger;
}): Promise<void> {
  const { config, orgs, log } = deps;
  const name = config.org.name;
  if (!name) {
    log.info("tenancy: no org configured (CANVAS_DROP_ORG_NAME unset) — whole_org is org-agnostic");
    return;
  }

  const org = await orgs.ensureOrg({ name, slug: orgSlug(name), domains: config.org.domains });

  // P1 supports exactly one org (multi-org is Phase 3). More than one means stale rows
  // from a prior/abandoned multi-org state — refuse to boot rather than mis-scope.
  const all = await orgs.list();
  if (all.length > 1) {
    throw new Error(
      `tenancy boot guard: ${all.length} orgs exist, but P1 supports exactly one (multi-org is Phase 3). ` +
        "Remove stale org rows or run the Phase 3 config.",
    );
  }

  const domains = await orgs.listDomains(org.id);
  // Fail loud on a domainless org (review fix): tenancyActive keys off the org NAME, but
  // membership keys off its DOMAINS. An org with no domains activates a member boundary
  // nobody can be on the inside of — every member resolves to ∅, so every whole_org canvas
  // becomes invisible to everyone. Refuse to boot rather than silently mis-scope.
  if (domains.length === 0) {
    throw new Error(
      `tenancy boot guard: org "${org.name}" has no domains. Set CANVAS_DROP_ORG_DOMAINS ` +
        "(or CANVAS_DROP_ALLOWED_EMAIL_DOMAINS) — without domains no user can be a member " +
        "and every whole_org canvas becomes invisible.",
    );
  }
  log.info({ org: org.name, slug: org.slug, domains }, "tenancy: org materialized");
}

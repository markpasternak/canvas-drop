import { normalizeDomain } from "@canvas-drop/shared";
import { type Org, type OrgDomain, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

/**
 * Tenancy org store (plan 002 U2). Backs the single org materialized from operator
 * config at boot (KTD4) and the membership lookup the DI resolver uses (U3). Domains
 * are stored + matched normalized (lowercase, exact) so `findByDomain` is an index
 * hit and membership is deterministic. Dual-dialect seam typed `any` like the other
 * repos; the {@link Org}/{@link OrgDomain} rows stay typed.
 */
export function orgsRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const orgsT = client.dialect === "sqlite" ? sqliteSchema.orgs : pgSchema.orgs;
  const domainsT = client.dialect === "sqlite" ? sqliteSchema.orgDomains : pgSchema.orgDomains;

  return {
    /**
     * Idempotent upsert of one org (keyed by `slug`) plus its domains. Domains are
     * normalized; a domain already mapped to a DIFFERENT org throws (boot guard, KTD4 —
     * a domain belongs to exactly one org). Re-running with the same config is a no-op.
     */
    async ensureOrg(input: { name: string; slug: string; domains: string[] }): Promise<Org> {
      const now = Date.now();
      const existing = (
        await db.select().from(orgsT).where(eq(orgsT.slug, input.slug)).limit(1)
      )[0] as Org | undefined;

      let org: Org;
      if (existing) {
        const rows = await db
          .update(orgsT)
          .set({ name: input.name })
          .where(eq(orgsT.id, existing.id))
          .returning();
        org = rows[0] as Org;
      } else {
        const rows = await db
          .insert(orgsT)
          .values({ id: uuidv7(), name: input.name, slug: input.slug, createdAt: now })
          .returning();
        org = rows[0] as Org;
      }

      const configured = input.domains.map(normalizeDomain);
      const configuredSet = new Set(configured);
      for (const domain of configured) {
        const cur = (
          await db.select().from(domainsT).where(eq(domainsT.domain, domain)).limit(1)
        )[0] as OrgDomain | undefined;
        if (cur && cur.orgId !== org.id) {
          throw new Error(
            `org domain "${domain}" is already mapped to a different org; a domain maps to exactly one org (plan 002 KTD4)`,
          );
        }
        if (!cur) {
          await db
            .insert(domainsT)
            .values({ id: uuidv7(), orgId: org.id, domain, verifiedAt: now, createdAt: now })
            .onConflictDoNothing();
        }
      }
      // Make the configured set AUTHORITATIVE (plan 002 — review fix): prune any of this
      // org's domains that are no longer in config. Without this, a domain removed from
      // CANVAS_DROP_ORG_DOMAINS keeps granting membership forever (findByDomain still
      // resolves it) — the isolation boundary could only widen, never narrow. A removed
      // domain's users correctly drop to guest (∅) on their next request after a reboot.
      const existingDomains = (await db
        .select({ domain: domainsT.domain })
        .from(domainsT)
        .where(eq(domainsT.orgId, org.id))) as Array<{ domain: string }>;
      for (const { domain } of existingDomains) {
        if (!configuredSet.has(domain)) {
          await db
            .delete(domainsT)
            .where(and(eq(domainsT.orgId, org.id), eq(domainsT.domain, domain)));
        }
      }
      return org;
    },

    /** The org owning this (already-normalized) domain, or null. Exact match, index hit. */
    async findByDomain(domain: string): Promise<Org | null> {
      const rows = (await db
        .select({ org: orgsT })
        .from(domainsT)
        .innerJoin(orgsT, eq(domainsT.orgId, orgsT.id))
        .where(eq(domainsT.domain, domain))
        .limit(1)) as Array<{ org: Org }>;
      return rows[0]?.org ?? null;
    },

    /** The normalized domains attached to an org (sorted for stable output). */
    async listDomains(orgId: string): Promise<string[]> {
      const rows = (await db
        .select({ domain: domainsT.domain })
        .from(domainsT)
        .where(eq(domainsT.orgId, orgId))) as Array<{ domain: string }>;
      return rows.map((r) => r.domain).sort();
    },

    async findById(id: string): Promise<Org | null> {
      const rows = (await db.select().from(orgsT).where(eq(orgsT.id, id)).limit(1)) as Org[];
      return rows[0] ?? null;
    },

    /** All orgs (P1 invariant: exactly one once materialized). Used by the boot guard. */
    async list(): Promise<Org[]> {
      return (await db.select().from(orgsT).orderBy(orgsT.createdAt)) as Org[];
    },
  };
}

export type OrgsRepository = ReturnType<typeof orgsRepository>;

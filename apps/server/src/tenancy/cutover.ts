import { domainOfEmail } from "@canvas-drop/shared";
import { pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { DbClient } from "../db/factory.js";
import type { OrgsRepository } from "../db/repositories/orgs.js";

/**
 * Tenancy cutover (plan 002 U8). Auto-scopes existing data once an org is configured:
 *
 *  - {@link planTenancy} is a READ-ONLY dry-run — it classifies every user (member/guest)
 *    and computes each canvas's home org + the access delta, with NO writes. Run it
 *    against a restored copy of production and review the report before applying.
 *  - {@link applyTenancy} is the idempotent backfill: it sets `org_id` by OWNER domain
 *    `WHERE org_id IS NULL` (so it resumes after a partial run and never re-touches a
 *    corrected row), and CLAMPS any guest-owned `whole_org` canvas down to `private` — a
 *    `whole_org` row whose org_id resolves to null is an explicit-deny everywhere (U4),
 *    but leaving it is a latent footgun (KTD6).
 *  - {@link verifyTenancy} re-runs the plan after apply and asserts zero remaining changes.
 *
 * The cutover crosses the dual-dialect seam in one place (like ops/backup.ts), reading the
 * tables directly; the two schemas are kept in lockstep so the queries behave identically.
 */

// biome-ignore lint/suspicious/noExplicitAny: single documented dual-dialect boundary
type AnyDb = any;

function tables(client: DbClient) {
  return client.dialect === "sqlite"
    ? { users: sqliteSchema.users, canvases: sqliteSchema.canvases }
    : { users: pgSchema.users, canvases: pgSchema.canvases };
}

/** Map each normalized org domain → its org id (a domain belongs to exactly one org). */
async function domainOrgMap(orgs: Pick<OrgsRepository, "list" | "listDomains">) {
  const map = new Map<string, string>();
  for (const org of await orgs.list()) {
    for (const domain of await orgs.listDomains(org.id)) map.set(domain, org.id);
  }
  return map;
}

export interface CanvasPlan {
  id: string;
  slug: string;
  ownerDomain: string | null;
  /** The org this canvas will be homed in (owner's domain → org), or null (personal). */
  assignOrgId: string | null;
  accessBefore: string;
  accessAfter: string;
}

export interface TenancyPlan {
  users: {
    total: number;
    members: number;
    guests: number;
    /** Users who can sign in but resolve to NO org — the surprising reclassification the
     *  operator must review (admins on a non-org domain are flagged explicitly). */
    reclassifiedAdmins: Array<{ email: string }>;
  };
  canvases: {
    total: number;
    /** Canvases (any rung) that will GET an org_id because their owner is a member. */
    willAssignOrg: number;
    /** Guest-owned whole_org canvases that will be CLAMPED to private. */
    willClampToPrivate: number;
    /** Canvases already homed (org_id set) — skipped by the idempotent apply. */
    alreadyScoped: number;
  };
  details: CanvasPlan[];
}

/** READ-ONLY: classify users + compute each canvas's home org and access delta. No writes. */
export async function planTenancy(
  client: DbClient,
  orgs: Pick<OrgsRepository, "list" | "listDomains">,
): Promise<TenancyPlan> {
  const db = client.db as AnyDb;
  const t = tables(client);
  const domMap = await domainOrgMap(orgs);

  const users = (await db
    .select({ id: t.users.id, email: t.users.email, isAdmin: t.users.isAdmin })
    .from(t.users)) as Array<{ id: string; email: string; isAdmin: boolean }>;

  const userOrg = new Map<string, string | null>();
  const userDomain = new Map<string, string | null>();
  let members = 0;
  let guests = 0;
  const reclassifiedAdmins: Array<{ email: string }> = [];
  for (const u of users) {
    const domain = domainOfEmail(u.email);
    const orgId = domain ? (domMap.get(domain) ?? null) : null;
    userOrg.set(u.id, orgId);
    userDomain.set(u.id, domain);
    if (orgId) members++;
    else {
      guests++;
      if (u.isAdmin) reclassifiedAdmins.push({ email: u.email });
    }
  }

  const canvases = (await db
    .select({
      id: t.canvases.id,
      slug: t.canvases.slug,
      ownerId: t.canvases.ownerId,
      access: t.canvases.access,
      orgId: t.canvases.orgId,
    })
    .from(t.canvases)
    // Skip soft-deleted tombstones (status='deleted'): they're never served, so homing or
    // clamping them is pointless and pollutes the report with phantom changes. Archived
    // canvases ARE processed — they can be restored, so they should carry the right home.
    .where(ne(t.canvases.status, "deleted"))) as Array<{
    id: string;
    slug: string;
    ownerId: string;
    access: string;
    orgId: string | null;
  }>;

  let willAssignOrg = 0;
  let willClampToPrivate = 0;
  let alreadyScoped = 0;
  const details: CanvasPlan[] = [];
  for (const cv of canvases) {
    if (cv.orgId) {
      alreadyScoped++;
      continue;
    }
    const ownerOrg = userOrg.get(cv.ownerId) ?? null;
    let accessAfter = cv.access;
    if (ownerOrg !== null) willAssignOrg++;
    if (cv.access === "whole_org" && ownerOrg === null) {
      accessAfter = "private"; // clamp the guest-owned whole_org footgun
      willClampToPrivate++;
    }
    details.push({
      id: cv.id,
      slug: cv.slug,
      ownerDomain: userDomain.get(cv.ownerId) ?? null,
      assignOrgId: ownerOrg,
      accessBefore: cv.access,
      accessAfter,
    });
  }

  return {
    users: { total: users.length, members, guests, reclassifiedAdmins },
    canvases: { total: canvases.length, willAssignOrg, willClampToPrivate, alreadyScoped },
    details,
  };
}

/**
 * Idempotent apply: set org_id by owner domain WHERE org_id IS NULL, then clamp guest-owned
 * whole_org → private. Returns the counts actually written. Re-running is a no-op.
 */
export async function applyTenancy(
  client: DbClient,
  orgs: Pick<OrgsRepository, "list" | "listDomains">,
): Promise<{ assigned: number; clamped: number }> {
  const db = client.db as AnyDb;
  const t = tables(client);
  const plan = await planTenancy(client, orgs);

  let assigned = 0;
  let clamped = 0;
  for (const cv of plan.details) {
    if (cv.assignOrgId !== null) {
      // Set the home org only on a still-null row (resume-safe; never re-touch a fix).
      await db
        .update(t.canvases)
        .set({ orgId: cv.assignOrgId })
        .where(and(eq(t.canvases.id, cv.id), isNull(t.canvases.orgId)));
      assigned++;
    } else if (cv.accessBefore === "whole_org" && cv.accessAfter === "private") {
      // Guest-owned whole_org → private (org_id stays null = personal).
      await db
        .update(t.canvases)
        .set({ access: "private" })
        .where(and(eq(t.canvases.id, cv.id), eq(t.canvases.access, "whole_org")));
      clamped++;
    }
  }
  return { assigned, clamped };
}

/** Re-run the plan after apply and assert nothing remains to change (zero deltas). */
export async function verifyTenancy(
  client: DbClient,
  orgs: Pick<OrgsRepository, "list" | "listDomains">,
): Promise<{ ok: boolean; plan: TenancyPlan }> {
  const plan = await planTenancy(client, orgs);
  const ok = plan.canvases.willAssignOrg === 0 && plan.canvases.willClampToPrivate === 0;
  return { ok, plan };
}

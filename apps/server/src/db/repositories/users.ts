import { pgSchema, sqliteSchema, type User } from "@canvas-drop/shared/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

export interface UpsertUserInput {
  providerSub: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  isAdmin: boolean;
}

export interface UserSearchResult {
  id: string;
  email: string;
  name: string;
}

function escapedLikePattern(q: string): string {
  return `%${q
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Users repository.
 *
 * The drizzle call is typed `any` here — this is the dual-dialect seam (KTD-1):
 * `pgTable` and `sqliteTable` are distinct compile-time builders, so a single
 * statement can't be typed over both. Inputs and the returned row shape stay
 * strongly typed ({@link User}); schema.test.ts guarantees both dialects yield
 * identical row shapes, so the boundary cast is safe.
 */
export function usersRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const t = client.dialect === "sqlite" ? sqliteSchema.users : pgSchema.users;

  return {
    async findById(id: string): Promise<User | null> {
      const rows = await db.select().from(t).where(eq(t.id, id)).limit(1);
      return (rows[0] as User | undefined) ?? null;
    },

    async findByProviderSub(providerSub: string): Promise<User | null> {
      const rows = await db.select().from(t).where(eq(t.providerSub, providerSub)).limit(1);
      return (rows[0] as User | undefined) ?? null;
    },

    /** Find an org user by email, case-insensitively (emails are stored as provided
     *  by the IdP, which may differ in case from a typed allowlist entry). Used to
     *  resolve a `specific_people` member-add (U4). */
    async findByEmail(email: string): Promise<User | null> {
      const rows = await db
        .select()
        .from(t)
        .where(sql`lower(${t.email}) = ${email.trim().toLowerCase()}`)
        .limit(1);
      return (rows[0] as User | undefined) ?? null;
    },

    /** Restore/revoke the publish-public capability. Admin-only at the route. */
    async setPublishPublic(id: string, value: boolean): Promise<User> {
      const rows = await db
        .update(t)
        .set({ canPublishPublic: value })
        .where(eq(t.id, id))
        .returning();
      return rows[0] as User;
    },

    /** Batched lookup for enriching the admin all-canvases list (M7) — no N+1. */
    async findByIds(ids: readonly string[]): Promise<User[]> {
      if (ids.length === 0) return [];
      return (await db
        .select()
        .from(t)
        .where(inArray(t.id, [...ids]))) as User[];
    },

    /** Search signed-in, unblocked users by name/email. Used only when tenancy is inactive. */
    async search(q: string, limit = 8): Promise<UserSearchResult[]> {
      const pattern = escapedLikePattern(q);
      return (await db
        .select({ id: t.id, email: t.email, name: t.name })
        .from(t)
        .where(
          and(
            eq(t.isBlocked, false),
            sql`(lower(${t.name}) like ${pattern} escape '\\' or lower(${t.email}) like ${pattern} escape '\\')`,
          ),
        )
        .orderBy(sql`lower(${t.email}) asc`, desc(t.id))
        .limit(limit)) as UserSearchResult[];
    },

    /** Total user count for the platform overview (M7, §6.10.6). */
    async count(): Promise<number> {
      const rows = (await db.select({ count: sql<number>`count(*)` }).from(t)) as Array<{
        count: number;
      }>;
      return Number(rows[0]?.count ?? 0);
    },

    /**
     * Create the user on first sight, or update mutable identity fields and
     * `last_seen_at`. Keyed on `provider_sub` so a returning identity never
     * creates a duplicate.
     */
    async upsert(input: UpsertUserInput): Promise<User> {
      const now = Date.now();
      // Atomic INSERT ... ON CONFLICT DO UPDATE on both dialects — avoids the
      // read-then-write race where two concurrent first-logins for the same
      // provider_sub both INSERT and the second 500s on the unique constraint.
      // is_blocked and created_at are intentionally NOT in the update set, so a
      // login never resurrects a blocked user or rewrites the creation time.
      //
      // Bootstrap admin model: the env allowlist (CANVAS_DROP_ADMIN_EMAILS) SEEDS
      // admins on first insert and can still promote an existing user (idempotently)
      // on any login — but it NEVER demotes. Once the bit is set (here, or via an
      // in-app `setAdmin` grant) it persists in the DB, so dropping someone from the
      // allowlist no longer auto-demotes them and an admin-granted user survives a
      // re-login. We therefore only ever fold isAdmin=true into the update set.
      const update: Record<string, unknown> = {
        email: input.email,
        name: input.name,
        avatarUrl: input.avatarUrl ?? null,
        lastSeenAt: now,
      };
      if (input.isAdmin) update.isAdmin = true;
      const rows = await db
        .insert(t)
        .values({
          id: uuidv7(),
          providerSub: input.providerSub,
          email: input.email,
          name: input.name,
          avatarUrl: input.avatarUrl ?? null,
          isAdmin: input.isAdmin,
          isBlocked: false,
          // The public-link rollout is default-on. Set this explicitly rather than
          // relying on the DB default so SQLite can avoid a destructive table rebuild
          // just to alter an existing column default.
          canPublishPublic: true,
          createdAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({ target: t.providerSub, set: update })
        .returning();
      return rows[0] as User;
    },

    async touchLastSeen(id: string): Promise<void> {
      await db.update(t).set({ lastSeenAt: Date.now() }).where(eq(t.id, id));
    },

    /** Block or unblock a user (admin user-management; gateway rejects blocked users). */
    async setBlocked(id: string, isBlocked: boolean): Promise<void> {
      await db.update(t).set({ isBlocked }).where(eq(t.id, id));
    },

    /**
     * Grant or revoke admin (in-app user-management, bootstrap model). Persists in
     * the DB: a login no longer clobbers it (see {@link upsert}). The route guards
     * self-demotion and last-admin demotion before calling this.
     */
    async setAdmin(id: string, isAdmin: boolean): Promise<void> {
      await db.update(t).set({ isAdmin }).where(eq(t.id, id));
    },

    /**
     * Count of *functioning* admins — backs the last-admin demote/block guards.
     * Blocked admins are excluded: the gateway rejects them per request, so a
     * blocked admin can't administer anything and must not pad the guard count
     * (otherwise demoting/blocking the last usable admin could lock the org out).
     */
    async countAdmins(): Promise<number> {
      const rows = (await db
        .select({ count: sql<number>`count(*)` })
        .from(t)
        .where(and(eq(t.isAdmin, true), eq(t.isBlocked, false)))) as Array<{ count: number }>;
      return Number(rows[0]?.count ?? 0);
    },
  };
}

export type UsersRepository = ReturnType<typeof usersRepository>;

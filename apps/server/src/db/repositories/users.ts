import { pgSchema, sqliteSchema, type User } from "@canvas-drop/shared/db";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbClient } from "../factory.js";

export interface UpsertUserInput {
  providerSub: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  isAdmin: boolean;
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

    /**
     * Create the user on first sight, or update mutable identity fields and
     * `last_seen_at`. Keyed on `provider_sub` so a returning identity never
     * creates a duplicate.
     */
    async upsert(input: UpsertUserInput): Promise<User> {
      const now = Date.now();
      const existing = await db
        .select()
        .from(t)
        .where(eq(t.providerSub, input.providerSub))
        .limit(1);
      const current = existing[0] as User | undefined;

      if (current) {
        const updated = await db
          .update(t)
          .set({
            email: input.email,
            name: input.name,
            avatarUrl: input.avatarUrl ?? null,
            isAdmin: input.isAdmin,
            lastSeenAt: now,
          })
          .where(eq(t.id, current.id))
          .returning();
        return updated[0] as User;
      }

      const inserted = await db
        .insert(t)
        .values({
          id: uuidv7(),
          providerSub: input.providerSub,
          email: input.email,
          name: input.name,
          avatarUrl: input.avatarUrl ?? null,
          isAdmin: input.isAdmin,
          isBlocked: false,
          createdAt: now,
          lastSeenAt: now,
        })
        .returning();
      return inserted[0] as User;
    },

    async touchLastSeen(id: string): Promise<void> {
      await db.update(t).set({ lastSeenAt: Date.now() }).where(eq(t.id, id));
    },

    /** Block or unblock a user (admin user-management; gateway rejects blocked users). */
    async setBlocked(id: string, isBlocked: boolean): Promise<void> {
      await db.update(t).set({ isBlocked }).where(eq(t.id, id));
    },
  };
}

export type UsersRepository = ReturnType<typeof usersRepository>;

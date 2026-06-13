import { index, sqliteTable, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sqlite as c } from "./columns.js";

/**
 * SQLite schema (BUILD_BRIEF.md §10). Structurally identical to schema.pg.ts —
 * same columns, same constraints, SQLite builders. Parity is enforced by
 * schema.test.ts + the dual-dialect CI matrix (KTD-1).
 */
export const users = sqliteTable(
  "users",
  {
    id: c.text("id").primaryKey(),
    providerSub: c.text("provider_sub").notNull(),
    email: c.text("email").notNull(),
    name: c.text("name").notNull(),
    avatarUrl: c.text("avatar_url"),
    isAdmin: c.bool("is_admin").notNull().default(false),
    isBlocked: c.bool("is_blocked").notNull().default(false),
    createdAt: c.epochMs("created_at").notNull(),
    lastSeenAt: c.epochMs("last_seen_at"),
  },
  (t) => [
    uniqueIndex("users_provider_sub_uq").on(t.providerSub),
    uniqueIndex("users_email_uq").on(t.email),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: c.text("id").primaryKey(),
    userId: c
      .text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: c.text("token_hash").notNull(),
    createdAt: c.epochMs("created_at").notNull(),
    expiresAt: c.epochMs("expires_at").notNull(),
    ip: c.text("ip"),
    userAgent: c.text("user_agent"),
    revokedAt: c.epochMs("revoked_at"),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_uq").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
  ],
);

export const settings = sqliteTable("settings", {
  key: c.text("key").primaryKey(),
  value: c.json("value").notNull(),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: c.text("id").primaryKey(),
    actorId: c.text("actor_id"),
    action: c.text("action").notNull(),
    targetType: c.text("target_type"),
    targetId: c.text("target_id"),
    meta: c.json("meta"),
    ip: c.text("ip"),
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [index("audit_log_created_at_idx").on(t.createdAt)],
);

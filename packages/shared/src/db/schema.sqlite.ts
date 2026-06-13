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

export const canvases = sqliteTable(
  "canvases",
  {
    id: c.text("id").primaryKey(),
    slug: c.text("slug").notNull(),
    title: c.text("title").notNull().default(""),
    description: c.text("description"),
    ownerId: c
      .text("owner_id")
      .notNull()
      .references(() => users.id),
    shared: c.bool("shared").notNull().default(false),
    sharedAt: c.epochMs("shared_at"),
    sharedExpiresAt: c.epochMs("shared_expires_at"),
    galleryListed: c.bool("gallery_listed").notNull().default(false),
    gallerySummary: c.text("gallery_summary"),
    galleryTags: c.json("gallery_tags"),
    galleryPublishedAt: c.epochMs("gallery_published_at"),
    passwordHash: c.text("password_hash"),
    // bumped on every password set/clear so outstanding gate cookies invalidate (U16)
    passwordVersion: c.int("password_version").notNull().default(0),
    spaFallback: c.bool("spa_fallback").notNull().default(false),
    apiKeyHash: c.text("api_key_hash").notNull(),
    status: c.text("status").notNull().default("active"), // active | disabled | deleted
    // Pointer (not an FK) to the current ready version — avoids a circular FK with
    // versions.canvas_id; nullable until the first deploy lands.
    currentVersionId: c.text("current_version_id"),
    createdAt: c.epochMs("created_at").notNull(),
    updatedAt: c.epochMs("updated_at").notNull(),
    deletedAt: c.epochMs("deleted_at"),
  },
  (t) => [uniqueIndex("canvases_slug_uq").on(t.slug), index("canvases_owner_id_idx").on(t.ownerId)],
);

export const versions = sqliteTable(
  "versions",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    number: c.int("number").notNull(), // per-canvas sequence
    createdBy: c
      .text("created_by")
      .notNull()
      .references(() => users.id),
    source: c.text("source").notNull(), // folder | zip | paste | api
    status: c.text("status").notNull().default("pending"), // pending | ready
    fileCount: c.int("file_count").notNull().default(0),
    totalBytes: c.int("total_bytes").notNull().default(0),
    manifest: c.json("manifest"), // path -> { size, hash, mime }; null until ready
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("versions_canvas_number_uq").on(t.canvasId, t.number),
    index("versions_canvas_created_idx").on(t.canvasId, t.createdAt),
  ],
);

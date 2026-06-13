import { sql } from "drizzle-orm";
import { check, index, sqliteTable, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    // Capability foundation (plan 006). `backendEnabled` is the Backend-group master
    // switch (off by default — static-first); the cap_* flags default ON so flipping
    // backend on yields all-features-live with no extra writes. Per-feature flags
    // persist independently of `backendEnabled` (turning backend off never clears them).
    // Effective state ANDs these with the operator global flags — see
    // packages/shared/src/capabilities. Identity (`me()`) has no column: it is on iff
    // backendEnabled. The deploy API key (`apiKeyHash`) is unrelated to this choice.
    backendEnabled: c.bool("backend_enabled").notNull().default(false),
    capKv: c.bool("cap_kv").notNull().default(true),
    capFiles: c.bool("cap_files").notNull().default(true),
    capAi: c.bool("cap_ai").notNull().default(true),
    capRealtime: c.bool("cap_realtime").notNull().default(true),
    apiKeyHash: c.text("api_key_hash").notNull(),
    status: c.text("status").notNull().default("active"), // active | disabled | archived | deleted
    // Pointer (not an FK) to the current ready version — avoids a circular FK with
    // versions.canvas_id; nullable until the first deploy lands.
    currentVersionId: c.text("current_version_id"),
    createdAt: c.epochMs("created_at").notNull(),
    updatedAt: c.epochMs("updated_at").notNull(),
    deletedAt: c.epochMs("deleted_at"),
  },
  (t) => [
    uniqueIndex("canvases_slug_uq").on(t.slug),
    // Owner's list, ordered newest-first → composite filter+sort.
    index("canvases_owner_created_idx").on(t.ownerId, t.createdAt),
    // Bearer-key deploy auth (findByApiKeyHash) — hot lookup + enforces key uniqueness.
    uniqueIndex("canvases_api_key_hash_uq").on(t.apiKeyHash),
    // Soft-delete purge sweep: WHERE status='deleted' AND deleted_at <= cutoff.
    index("canvases_status_deleted_idx").on(t.status, t.deletedAt),
    check("canvases_status_chk", sql`${t.status} in ('active', 'disabled', 'archived', 'deleted')`),
  ],
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
    // (canvas_id, number) covers every versions query — filter by canvas + sort by
    // number (history, prune, nextNumber's max). No separate created_at index needed.
    uniqueIndex("versions_canvas_number_uq").on(t.canvasId, t.number),
    check("versions_status_chk", sql`${t.status} in ('pending', 'ready')`),
    check("versions_source_chk", sql`${t.source} in ('folder', 'zip', 'paste', 'api', 'editor')`),
  ],
);

export const drafts = sqliteTable(
  "drafts",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    // path -> { size, hash, mime }; the working set of files, empty by default.
    manifest: c.json("manifest").notNull(),
    // The published version this draft was derived from (null for a never-published canvas).
    baseVersionId: c.text("base_version_id"),
    // Set when a direct publish (deploy API / re-upload) landed under this draft (M5 R15/F3).
    stale: c.bool("stale").notNull().default(false),
    createdAt: c.epochMs("created_at").notNull(),
    updatedAt: c.epochMs("updated_at").notNull(),
  },
  (t) => [
    // Exactly one draft per canvas (R10).
    uniqueIndex("drafts_canvas_id_uq").on(t.canvasId),
  ],
);

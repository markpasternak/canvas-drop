import { sql } from "drizzle-orm";
import { check, index, primaryKey, sqliteTable, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    // Access rung (D4 ladder): private | specific_people | whole_org | public_link.
    // Replaces the former `shared` boolean — `whole_org` is its successor.
    access: c.text("access").notNull().default("private"),
    sharedExpiresAt: c.epochMs("shared_expires_at"),
    galleryListed: c.bool("gallery_listed").notNull().default(false),
    // Opt-in "others may clone this as a template" flag. Invariant: only ever true
    // when galleryListed is true — every path that clears galleryListed also clears
    // this in the same write (plan 002 KTD6).
    galleryTemplatable: c.bool("gallery_templatable").notNull().default(false),
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
    // Admin takedown reason (§6.10.2 / M7). Owner-facing durable state so the owner
    // can see WHY their canvas was disabled; null unless status='disabled'. Who/when
    // is NOT duplicated here — it lives in audit_log (action='canvas_disable'). Cleared
    // on enable/restore.
    disabledReason: c.text("disabled_reason"),
    // Pointer (not an FK) to the current ready version — avoids a circular FK with
    // versions.canvas_id; nullable until the first deploy lands.
    currentVersionId: c.text("current_version_id"),
    // Lineage: the canvas this one was cloned from (plan 002). Pointer, not an FK —
    // the source may be archived/purged independently; null for non-clones.
    clonedFromCanvasId: c.text("cloned_from_canvas_id"),
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
    check(
      "canvases_access_chk",
      sql`${t.access} in ('private', 'specific_people', 'whole_org', 'public_link')`,
    ),
  ],
);

// Per-canvas access allowlist (D4 `specific_people` rung). Each row is one
// principal allowed to reach the canvas: an org `member` (by user_id) or a `guest`
// (by email — the guest's magic-link session is keyed back to this entry). Unique
// per (canvas, user_id) and (canvas, email). Removing a row revokes on the next
// request (no cached grants).
export const canvasAllowlist = sqliteTable(
  "canvas_allowlist",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    principalKind: c.text("principal_kind").notNull(), // member | guest
    userId: c.text("user_id").references(() => users.id),
    email: c.text("email"),
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [
    index("canvas_allowlist_canvas_idx").on(t.canvasId),
    uniqueIndex("canvas_allowlist_canvas_user_uq").on(t.canvasId, t.userId),
    uniqueIndex("canvas_allowlist_canvas_email_uq").on(t.canvasId, t.email),
    check("canvas_allowlist_kind_chk", sql`${t.principalKind} in ('member', 'guest')`),
  ],
);

// Guest invites (D4 email-invited guests, U6). One per (canvas, email): the
// magic-link token is stored hashed (never plaintext). `state` is pending until
// first consumed (→ active), or revoked; expiry is the optional per-invite clock.
export const guestInvites = sqliteTable(
  "guest_invites",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    email: c.text("email").notNull(),
    tokenHash: c.text("token_hash").notNull(),
    state: c.text("state").notNull().default("pending"), // pending | active | revoked
    expiresAt: c.epochMs("expires_at"),
    consumedAt: c.epochMs("consumed_at"),
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("guest_invites_token_hash_uq").on(t.tokenHash),
    uniqueIndex("guest_invites_canvas_email_uq").on(t.canvasId, t.email),
    check("guest_invites_state_chk", sql`${t.state} in ('pending', 'active', 'revoked')`),
  ],
);

// Guest sessions (U6): a magic-link consume mints one. Scoped to the invited
// canvas; the session token is stored hashed. Honored only while the session AND
// its invite are live (resolveGuest cross-checks the invite — R12).
export const guestSessions = sqliteTable(
  "guest_sessions",
  {
    id: c.text("id").primaryKey(),
    inviteId: c
      .text("invite_id")
      .notNull()
      .references(() => guestInvites.id),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    tokenHash: c.text("token_hash").notNull(),
    expiresAt: c.epochMs("expires_at").notNull(),
    revokedAt: c.epochMs("revoked_at"),
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("guest_sessions_token_hash_uq").on(t.tokenHash),
    index("guest_sessions_invite_idx").on(t.inviteId),
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

// Per-op metering substrate (D24, plan 007 / M6). Append-only; one row per
// primitive op (kv_op | file_op; future: view | deploy | rt_connect). Stats are
// derived by COUNT over a window; a created_at-keyed prune bounds growth.
export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    userId: c
      .text("user_id")
      .notNull()
      .references(() => users.id),
    type: c.text("type").notNull(), // kv_op | file_op | view | deploy | rt_connect
    meta: c.json("meta"), // op detail, e.g. { op: 'set' }
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [
    // Stats aggregation + retention prune both filter by canvas + created_at.
    index("usage_events_canvas_created_idx").on(t.canvasId, t.createdAt),
    // recordView's per-viewer dedup runs on the serve hot path and filters
    // (canvas_id, user_id, type, created_at>=since) — this composite makes it a
    // prefix probe instead of scanning every event for the canvas.
    index("usage_events_canvas_user_type_created_idx").on(
      t.canvasId,
      t.userId,
      t.type,
      t.createdAt,
    ),
  ],
);

// KV primitive (§6.4, plan 007 / M6). `scope` is 'shared' for kv.* or the userId
// for kv.user.*; the composite PK (canvas_id, scope, key) also serves the
// (canvas_id, scope) prefix list. `value` is JSON (≤64 KB enforced at the
// boundary). Every write carries attribution (updated_by, updated_at).
export const kvEntries = sqliteTable(
  "kv_entries",
  {
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    scope: c.text("scope").notNull(), // 'shared' | <userId>
    key: c.text("key").notNull(),
    value: c.json("value").notNull(),
    updatedBy: c
      .text("updated_by")
      .notNull()
      .references(() => users.id),
    updatedAt: c.epochMs("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.scope, t.key] })],
);

// Files primitive (§6.5, plan 007 / M6). Per-canvas namespace; bytes live in the
// storage driver under `files/<canvasId>/<id>`, metadata here. Quota (1 GB/canvas)
// is SUM(size_bytes); 25 MB/file enforced at the upload boundary. Upload attribution.
export const files = sqliteTable(
  "files",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    filename: c.text("filename").notNull(),
    mime: c.text("mime").notNull(),
    sizeBytes: c.int("size_bytes").notNull(),
    storageKey: c.text("storage_key").notNull(),
    uploadedBy: c
      .text("uploaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [index("files_canvas_id_idx").on(t.canvasId)],
);

// AI primitive metering (§6.6.6, plan 009 / M9). One row per proxied AI call:
// attribution (canvas, user — both server-resolved), provider/model, token
// counts, and computed USD cost. `cost_usd` is summed over the per-user-daily and
// per-canvas-monthly windows for quota enforcement; the two indexes serve those
// windows (and the owner usage tab). This table is the single source of truth for
// AI tokens/cost/op-count — no parallel usage_events row.
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    userId: c
      .text("user_id")
      .notNull()
      .references(() => users.id),
    provider: c.text("provider").notNull(),
    model: c.text("model").notNull(),
    inputTokens: c.int("input_tokens").notNull(),
    outputTokens: c.int("output_tokens").notNull(),
    costUsd: c.real("cost_usd").notNull(),
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [
    index("ai_usage_canvas_created_idx").on(t.canvasId, t.createdAt),
    index("ai_usage_user_created_idx").on(t.userId, t.createdAt),
  ],
);

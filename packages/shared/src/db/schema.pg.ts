import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { pg as c } from "./columns.js";
// Type-only (fully erased at runtime — no module cycle) domain unions threaded
// onto the CHECK-constrained text columns so callers get compile-time-checked
// comparisons instead of raw `string`. Defined in types.js, the canonical surface.
import type {
  GuestInviteState,
  McpTokenKind,
  UsageEventType,
  VersionSource,
  VersionStatus,
} from "./types.js";

/**
 * Postgres schema (BUILD_BRIEF.md §10). Foundation tables only — canvases,
 * versions, kv, files, ai_usage, usage_events land with their features.
 *
 * Must stay structurally identical to schema.sqlite.ts; enforced by
 * schema.test.ts + the dual-dialect CI matrix.
 */
export const users = pgTable(
  "users",
  {
    id: c.text("id").primaryKey(),
    providerSub: c.text("provider_sub").notNull(),
    email: c.text("email").notNull(),
    name: c.text("name").notNull(),
    avatarUrl: c.text("avatar_url"),
    isAdmin: c.bool("is_admin").notNull().default(false),
    isBlocked: c.bool("is_blocked").notNull().default(false),
    // Admin-granted capability to publish a canvas as a static public link (D4
    // public_link rung, U10). Off by default; server-resolved, never client-asserted.
    canPublishPublic: c.bool("can_publish_public").notNull().default(false),
    createdAt: c.epochMs("created_at").notNull(),
    lastSeenAt: c.epochMs("last_seen_at"),
  },
  (t) => [
    uniqueIndex("users_provider_sub_uq").on(t.providerSub),
    uniqueIndex("users_email_uq").on(t.email),
  ],
);

export const sessions = pgTable(
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

export const settings = pgTable("settings", {
  key: c.text("key").primaryKey(),
  value: c.json("value").notNull(),
});

// Remote MCP OAuth (agent control plane). DCR-registered clients, single-use
// authorization codes, and hashed access/refresh tokens — all minted only after
// the user authenticates via the existing login. Structurally identical to
// schema.sqlite.ts; parity is enforced by schema.test.ts (KTD-1).
export const oauthClients = pgTable("oauth_clients", {
  id: c.text("id").primaryKey(),
  // Full OAuthClientInformationFull blob, round-tripped for DCR fidelity.
  clientInfo: c.json("client_info").notNull(),
  createdAt: c.epochMs("created_at").notNull(),
});

export const oauthCodes = pgTable(
  "oauth_codes",
  {
    id: c.text("id").primaryKey(),
    codeHash: c.text("code_hash").notNull(),
    clientId: c.text("client_id").notNull(),
    userId: c
      .text("user_id")
      .notNull()
      .references(() => users.id),
    redirectUri: c.text("redirect_uri").notNull(),
    codeChallenge: c.text("code_challenge").notNull(),
    codeChallengeMethod: c.text("code_challenge_method"),
    scopes: c.json("scopes"),
    resource: c.text("resource"),
    expiresAt: c.epochMs("expires_at").notNull(),
    consumedAt: c.epochMs("consumed_at"),
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("oauth_codes_code_hash_uq").on(t.codeHash),
    index("oauth_codes_user_id_idx").on(t.userId),
  ],
);

export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: c.text("id").primaryKey(),
    tokenHash: c.text("token_hash").notNull(),
    // "access" | "refresh".
    kind: c.text("kind").$type<McpTokenKind>().notNull(),
    clientId: c.text("client_id").notNull(),
    userId: c
      .text("user_id")
      .notNull()
      .references(() => users.id),
    scopes: c.json("scopes"),
    expiresAt: c.epochMs("expires_at"),
    revokedAt: c.epochMs("revoked_at"),
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("mcp_tokens_token_hash_uq").on(t.tokenHash),
    index("mcp_tokens_user_id_idx").on(t.userId),
  ],
);

export const auditLog = pgTable(
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

export const canvases = pgTable(
  "canvases",
  {
    id: c.text("id").primaryKey(),
    slug: c.text("slug").notNull(),
    // True when the owner chose the slug (vs the readable-random generator). Drives
    // the "public + custom slug is human-guessable" heads-up; never an authz input.
    slugCustom: c.bool("slug_custom").notNull().default(false),
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
    tags: c.json("tags"),
    // Admin-curated editorial flag (cross-owner action; not on the per-account MCP
    // surface). Set only via the admin canvases route; surfaces in the public gallery.
    galleryFeatured: c.bool("gallery_featured").notNull().default(false),
    // Denormalized, normalized search blob = normalize(title + summary + tags + slug),
    // recomputed in the service layer on every write touching those fields. Nullable;
    // existing rows are populated by a one-time TS backfill, not a SQL migration step.
    searchText: c.text("search_text"),
    galleryPublishedAt: c.epochMs("gallery_published_at"),
    passwordHash: c.text("password_hash"),
    // bumped on every password set/clear so outstanding gate cookies invalidate (U16)
    passwordVersion: c.int("password_version").notNull().default(0),
    spaFallback: c.bool("spa_fallback").notNull().default(false),
    // Preview policy (plan 004 follow-up): `auto` = screenshot on publish (default);
    // `off` = no capture, show the generative cover; `custom` = owner-uploaded image,
    // never overwritten by a publish capture.
    previewMode: c.text("preview_mode").notNull().default("auto"),
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
    // Guest-AI opt-in (U9, KTD5): AI is off for invited guests by default (the
    // metered-$ surface). The owner may opt a canvas in; `guest_ai_cap` is the
    // per-canvas monthly USD ceiling for guest AI (0 = no extra cap beyond org).
    guestAiEnabled: c.bool("guest_ai_enabled").notNull().default(false),
    guestAiCap: c.real("guest_ai_cap").notNull().default(0),
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
    // Denormalized view rollups (plan 004 popularity). All-time deduped view count
    // and the last-counted-view timestamp, bumped inside `recordView` only when a
    // view row is actually inserted (the 30-min dedup "added"). They keep the
    // Your-canvases list O(1) for "last viewed" + a lifetime figure without touching
    // the append-only usage_events log; the trending (recent-window) number used by
    // the `popular` sort is a separate bounded aggregate over usage_events.
    viewCount: c.int("view_count").notNull().default(0),
    lastViewedAt: c.epochMs("last_viewed_at"),
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
export const canvasAllowlist = pgTable(
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
    // XOR invariant: a member row references a user (no email); a guest row carries
    // an email (no user). Enforces the principal coupling at the DB layer so a
    // malformed insert can't create a ghost/mis-routed grant (D4 access-control).
    check(
      "canvas_allowlist_member_chk",
      sql`${t.principalKind} != 'member' OR ${t.userId} IS NOT NULL`,
    ),
    check(
      "canvas_allowlist_guest_chk",
      sql`${t.principalKind} != 'guest' OR ${t.email} IS NOT NULL`,
    ),
  ],
);

// Guest invites (D4 email-invited guests, U6). One per (canvas, email): the
// magic-link token is stored hashed (never plaintext). `state` is pending until
// first consumed (→ active), or revoked; expiry is the optional per-invite clock.
export const guestInvites = pgTable(
  "guest_invites",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    email: c.text("email").notNull(),
    tokenHash: c.text("token_hash").notNull(),
    state: c.text("state").$type<GuestInviteState>().notNull().default("pending"), // pending | active | revoked
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
export const guestSessions = pgTable(
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
    // revokeAllForCanvas filters by canvas_id (lifecycle sweep on unpublish/archive).
    index("guest_sessions_canvas_idx").on(t.canvasId),
  ],
);

/**
 * Admin-managed individual sign-in allowlist (D14 supplement). Emails here may sign
 * in as org members even when their domain isn't in CANVAS_DROP_ALLOWED_EMAIL_DOMAINS
 * — an additive layer the domain allowlist (env) is unaware of. Stored lowercased.
 */
export const allowedEmails = pgTable(
  "allowed_emails",
  {
    id: c.text("id").primaryKey(),
    email: c.text("email").notNull(),
    /** Admin who added it (plain text; informational, no FK). */
    createdBy: c.text("created_by"),
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [uniqueIndex("allowed_emails_email_uq").on(t.email)],
);

export const versions = pgTable(
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
    source: c.text("source").$type<VersionSource>().notNull(), // folder | zip | paste | api | editor | upload
    status: c.text("status").$type<VersionStatus>().notNull().default("pending"), // pending | ready
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
    check(
      "versions_source_chk",
      sql`${t.source} in ('folder', 'zip', 'paste', 'api', 'editor', 'upload')`,
    ),
  ],
);

// Staging area for the two-channel upload flow (plan 003). One row per in-flight
// `begin → stage* → finalize` session: an owner+canvas-scoped, hashed, single-use
// handle plus the target manifest (recorded at begin, before any blob is staged —
// so the blob-GC live set always covers a staged blob's hash). Blobs land in the
// shared content-addressed store (canvases/{id}/blobs/{hash}); this row tracks
// which hashes have been staged and the finalize lifecycle. `finalizingAt` is the
// idempotent in-progress lease (cleared on transient failure so a legitimate retry
// can resume); `consumedAt` is terminal, set only on a successful pointer swap.
export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    ownerId: c
      .text("owner_id")
      .notNull()
      .references(() => users.id),
    handleHash: c.text("handle_hash").notNull(),
    // Target manifest (path -> { size, hash, mime }) recorded at begin.
    manifest: c.json("manifest").notNull(),
    // Hashes physically staged so far (subset of manifest hashes not already present).
    stagedHashes: c.json("staged_hashes").notNull(),
    expiresAt: c.epochMs("expires_at").notNull(),
    finalizingAt: c.epochMs("finalizing_at"),
    consumedAt: c.epochMs("consumed_at"),
    createdAt: c.epochMs("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("upload_sessions_handle_hash_uq").on(t.handleHash),
    index("upload_sessions_canvas_idx").on(t.canvasId),
    index("upload_sessions_expires_idx").on(t.expiresAt),
  ],
);

export const drafts = pgTable(
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
// primitive op. Current types: kv_op | file_op | view | deploy | rt_connect (all
// live — recordView writes 'view', canvas-realtime writes 'rt_connect'). Stats are
// derived by COUNT over a window; a created_at-keyed prune bounds growth.
export const usageEvents = pgTable(
  "usage_events",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    // Attribution: an org user id OR a guest principal id (`guest:<inviteId>`, U9),
    // so guest primitive ops are attributed — not an FK to users for that reason.
    userId: c.text("user_id").notNull(),
    type: c.text("type").$type<UsageEventType>().notNull(), // kv_op | file_op | view | deploy | rt_connect
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
export const kvEntries = pgTable(
  "kv_entries",
  {
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    scope: c.text("scope").notNull(), // 'shared' | <userId>
    key: c.text("key").notNull(),
    value: c.json("value").notNull(),
    // Attribution holds an org user id OR a guest principal id (U9) — not an FK.
    updatedBy: c.text("updated_by").notNull(),
    updatedAt: c.epochMs("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.scope, t.key] })],
);

// Files primitive (§6.5, plan 007 / M6). Per-canvas namespace; bytes live in the
// storage driver under `files/<canvasId>/<id>`, metadata here. Quota (1 GB/canvas)
// is SUM(size_bytes); 25 MB/file enforced at the upload boundary. Upload attribution.
export const files = pgTable(
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
    // Attribution holds an org user id OR a guest principal id (U9) — not an FK.
    uploadedBy: c.text("uploaded_by").notNull(),
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
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    // Attribution holds an org user id OR a guest principal id (U9) — not an FK.
    userId: c.text("user_id").notNull(),
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

// Screenshot capture jobs (plan 004 / U2). ONE row per canvas (unique canvas_id):
// publishing upserts it to `pending` with the new version_id, coalescing any prior
// pending capture to the latest version (only the newest is worth a shot) and
// bounding the table to one row per canvas. An in-process worker claims the oldest
// claimable row (pending, OR a `running` row whose lease expired — restart-safe),
// captures, and marks it done/failed. Screenshot-specific by design (no job_type
// column) — a second job type means a new table, not reuse (focused-pipeline KTD).
// Structurally identical to schema.sqlite.ts; parity enforced by schema.test.ts (KTD-1).
export const screenshotJobs = pgTable(
  "screenshot_jobs",
  {
    id: c.text("id").primaryKey(),
    canvasId: c
      .text("canvas_id")
      .notNull()
      .references(() => canvases.id),
    versionId: c.text("version_id").notNull(),
    status: c.text("status").notNull().default("pending"), // pending | running | done | failed
    attempts: c.int("attempts").notNull().default(0),
    // In-progress lease: set when claimed, cleared on terminal/retry. A `running` row
    // whose lease is older than the worker's lease window is reclaimed (restart-safe).
    leasedAt: c.epochMs("leased_at"),
    lastError: c.text("last_error"),
    createdAt: c.epochMs("created_at").notNull(),
    updatedAt: c.epochMs("updated_at").notNull(),
  },
  (t) => [
    // One job per canvas — the coalesce upsert's conflict target.
    uniqueIndex("screenshot_jobs_canvas_uq").on(t.canvasId),
    // claim/reclaim scan: pending rows + running rows past their lease.
    index("screenshot_jobs_status_leased_idx").on(t.status, t.leasedAt),
    // failed-row sweep: WHERE status='failed' AND updated_at <= cutoff.
    index("screenshot_jobs_status_updated_idx").on(t.status, t.updatedAt),
    check(
      "screenshot_jobs_status_chk",
      sql`${t.status} in ('pending', 'running', 'done', 'failed')`,
    ),
  ],
);

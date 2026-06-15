import type {
  aiUsage,
  auditLog,
  canvases,
  drafts,
  files,
  guestInvites,
  guestSessions,
  kvEntries,
  sessions,
  settings,
  usageEvents,
  users,
  versions,
} from "./schema.pg.js";

/** JSON value stored in `jsonb` (Postgres) / TEXT-json (SQLite) columns. */
export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

/**
 * Shared row types the repository layer codes against. Derived from the
 * Postgres schema as the canonical shape; `schema.test.ts` asserts the SQLite
 * schema infers the same types, enforcing dialect parity (KTD-1).
 */
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
export type Canvas = typeof canvases.$inferSelect;
export type NewCanvas = typeof canvases.$inferInsert;
export type Version = typeof versions.$inferSelect;
export type NewVersion = typeof versions.$inferInsert;
export type Draft = typeof drafts.$inferSelect;
export type NewDraft = typeof drafts.$inferInsert;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type KvEntry = typeof kvEntries.$inferSelect;
export type NewKvEntry = typeof kvEntries.$inferInsert;
export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
export type AiUsage = typeof aiUsage.$inferSelect;
export type NewAiUsage = typeof aiUsage.$inferInsert;
export type GuestInvite = typeof guestInvites.$inferSelect;
export type NewGuestInvite = typeof guestInvites.$inferInsert;
export type GuestSession = typeof guestSessions.$inferSelect;
export type NewGuestSession = typeof guestSessions.$inferInsert;

/** A deployed version's file manifest: path → content metadata. */
export type ManifestEntry = { size: number; hash: string; mime: string };
export type Manifest = Record<string, ManifestEntry>;

/** Canvas status values (stored as text, validated by zod at the boundary). */
export type CanvasStatus = "active" | "disabled" | "archived" | "deleted";

/**
 * Canvas access rung (D4 ladder). One rung per canvas, stored as text:
 *  - `private`         — owner/admin only (default)
 *  - `specific_people` — a named allowlist (org members and/or invited guests)
 *  - `whole_org`       — any authenticated org member with the link (the former "shared")
 *  - `public_link`     — anyone with the link; admin-gated per account; static-only
 */
export type AccessRung = "private" | "specific_people" | "whole_org" | "public_link";
export const ACCESS_RUNGS: readonly AccessRung[] = [
  "private",
  "specific_people",
  "whole_org",
  "public_link",
];

/** A canvas-allowlist principal kind (members reference a user row; guests an email). */
export type AllowlistPrincipalKind = "member" | "guest";
/** Version source values (`editor` = published from the in-browser draft, M5). */
export type DeploySource = "folder" | "zip" | "paste" | "api" | "editor";

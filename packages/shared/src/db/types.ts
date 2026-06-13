import type {
  auditLog,
  canvases,
  drafts,
  sessions,
  settings,
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

/** A deployed version's file manifest: path → content metadata. */
export type ManifestEntry = { size: number; hash: string; mime: string };
export type Manifest = Record<string, ManifestEntry>;

/** Canvas status values (stored as text, validated by zod at the boundary). */
export type CanvasStatus = "active" | "disabled" | "archived" | "deleted";
/** Version source values (`editor` = published from the in-browser draft, M5). */
export type DeploySource = "folder" | "zip" | "paste" | "api" | "editor";

import type { auditLog, sessions, settings, users } from "./schema.pg.js";

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

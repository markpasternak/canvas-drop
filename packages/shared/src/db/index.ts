/**
 * Dual-dialect database schema (KTD-1). Both dialect schemas and the shared row
 * types are exported here; the active dialect is selected by the DB factory
 * (apps/server/src/db/factory.ts) from config — never at import time.
 */
export * as pgSchema from "./schema.pg.js";
export * as sqliteSchema from "./schema.sqlite.js";
export * from "./publication-state.js";
export * from "./types.js";

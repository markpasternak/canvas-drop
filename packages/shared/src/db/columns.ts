import { bigint, boolean, doublePrecision, jsonb, text as pgText } from "drizzle-orm/pg-core";
import { integer, real as sqliteReal, text as sqliteText } from "drizzle-orm/sqlite-core";
import type { Json } from "./types.js";

/**
 * Shared column-shape helpers, one set per dialect (KTD-1). Both schema files
 * build their columns from the matching set so the two stay in lockstep:
 *
 *   - text identifiers (app-generated UUIDv7 — no DB uuid type)
 *   - timestamps as integer epoch milliseconds (no DB date/time types)
 *   - JSON as `jsonb` on Postgres, TEXT-json on SQLite
 *   - booleans as native bool on Postgres, 0/1 integer on SQLite
 *   - real as `double precision` on Postgres, REAL on SQLite (fractional USD)
 *
 * Portability rules: BUILD_BRIEF.md §10.
 */
export const pg = {
  text: (name: string) => pgText(name),
  epochMs: (name: string) => bigint(name, { mode: "number" }),
  int: (name: string) => bigint(name, { mode: "number" }),
  real: (name: string) => doublePrecision(name),
  bool: (name: string) => boolean(name),
  json: (name: string) => jsonb(name).$type<Json>(),
};

export const sqlite = {
  text: (name: string) => sqliteText(name),
  epochMs: (name: string) => integer(name),
  int: (name: string) => integer(name),
  real: (name: string) => sqliteReal(name),
  bool: (name: string) => integer(name, { mode: "boolean" }),
  json: (name: string) => sqliteText(name, { mode: "json" }).$type<Json>(),
};

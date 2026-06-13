import { getTableColumns } from "drizzle-orm";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as pg from "./schema.pg.js";
import * as sq from "./schema.sqlite.js";

/** Tables keyed identically across both dialect modules. */
const pgTables = {
  users: pg.users,
  sessions: pg.sessions,
  settings: pg.settings,
  auditLog: pg.auditLog,
  canvases: pg.canvases,
  versions: pg.versions,
};
const sqliteTables = {
  users: sq.users,
  sessions: sq.sessions,
  settings: sq.settings,
  auditLog: sq.auditLog,
  canvases: sq.canvases,
  versions: sq.versions,
};

const TABLE_KEYS = Object.keys(pgTables) as Array<keyof typeof pgTables>;

describe("dual-dialect schema parity (KTD-1)", () => {
  type ColShape = Record<string, { name: string; notNull: boolean; primary: boolean }>;

  it.each(TABLE_KEYS)("%s has an identical column shape across dialects", (key) => {
    const pgCols = getTableColumns(pgTables[key]) as ColShape;
    const sqCols = getTableColumns(sqliteTables[key]) as ColShape;

    expect(Object.keys(pgCols).sort()).toEqual(Object.keys(sqCols).sort());

    for (const col of Object.keys(pgCols)) {
      const p = pgCols[col];
      const s = sqCols[col];
      expect(s, `${key}.${col} missing on sqlite`).toBeDefined();
      expect(s?.name, `${key}.${col} db column name`).toBe(p?.name);
      expect(s?.notNull, `${key}.${col} notNull`).toBe(p?.notNull);
      expect(s?.primary, `${key}.${col} primary`).toBe(p?.primary);
    }
  });

  // Indexes/uniqueness/FKs are security-relevant (e.g. sessions_token_hash_uq
  // underpins findLiveByToken). getTableColumns misses them, so assert them
  // explicitly — otherwise a uniqueIndex dropped on one dialect drifts silently.
  it.each(TABLE_KEYS)("%s has identical indexes and foreign keys across dialects", (key) => {
    const pgCfg = getPgTableConfig(pgTables[key]);
    const sqCfg = getSqliteTableConfig(sqliteTables[key]);

    const indexShape = (
      indexes: Array<{ config: { name?: string; unique?: boolean; columns: unknown[] } }>,
    ) =>
      indexes
        .map((i) => {
          const cols = (i.config.columns as Array<{ name?: string }>)
            .map((c) => c.name ?? String(c))
            .join(",");
          return `${i.config.name}:${i.config.unique ? "uniq" : "idx"}:${cols}`;
        })
        .sort();

    expect(indexShape(sqCfg.indexes as never), `${key} indexes`).toEqual(
      indexShape(pgCfg.indexes as never),
    );

    const fkShape = (fks: Array<{ reference: () => { columns: Array<{ name: string }> } }>) =>
      fks
        .map((fk) =>
          fk
            .reference()
            .columns.map((c) => c.name)
            .join(","),
        )
        .sort();
    expect(fkShape(sqCfg.foreignKeys as never), `${key} foreign keys`).toEqual(
      fkShape(pgCfg.foreignKeys as never),
    );
  });
});

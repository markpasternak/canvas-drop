import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as pg from "./schema.pg.js";
import * as sq from "./schema.sqlite.js";

/** Tables keyed identically across both dialect modules. */
const pgTables = {
  users: pg.users,
  sessions: pg.sessions,
  settings: pg.settings,
  auditLog: pg.auditLog,
};
const sqliteTables = {
  users: sq.users,
  sessions: sq.sessions,
  settings: sq.settings,
  auditLog: sq.auditLog,
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
});

import { describe, expect, it } from "vitest";
import { isUniqueViolation, SLUG_UNIQUE } from "./unique-violation.js";

describe("isUniqueViolation", () => {
  it("matches a better-sqlite3 slug unique violation (column in message)", () => {
    const err = Object.assign(new Error("UNIQUE constraint failed: canvases.slug"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    expect(isUniqueViolation(err, SLUG_UNIQUE)).toBe(true);
  });

  it("matches a postgres slug unique violation via err.constraint", () => {
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "canvases_slug_uq"'),
      { code: "23505", constraint: "canvases_slug_uq" },
    );
    expect(isUniqueViolation(err, SLUG_UNIQUE)).toBe(true);
  });

  it("matches a postgres slug unique violation via message when constraint is absent (pglite)", () => {
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "canvases_slug_uq"'),
      { code: "23505" },
    );
    expect(isUniqueViolation(err, SLUG_UNIQUE)).toBe(true);
  });

  it("matches a drizzle-wrapped postgres error (DatabaseError nested under .cause)", () => {
    // Drizzle's outer error has code:undefined; the real one is under .cause (pglite/pg).
    const err = Object.assign(new Error("Failed query: insert into canvases …"), {
      cause: { code: "23505", constraint: "canvases_slug_uq", message: "duplicate key" },
    });
    expect(isUniqueViolation(err, SLUG_UNIQUE)).toBe(true);
  });

  it("does NOT match a different unique index on the same table (api key hash)", () => {
    const sqliteErr = Object.assign(new Error("UNIQUE constraint failed: canvases.api_key_hash"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    const pgErr = Object.assign(
      new Error('duplicate key value violates unique constraint "canvases_api_key_hash_uq"'),
      { code: "23505", constraint: "canvases_api_key_hash_uq" },
    );
    expect(isUniqueViolation(sqliteErr, SLUG_UNIQUE)).toBe(false);
    expect(isUniqueViolation(pgErr, SLUG_UNIQUE)).toBe(false);
  });

  it("does NOT match unrelated errors", () => {
    expect(isUniqueViolation(new Error("boom"), SLUG_UNIQUE)).toBe(false);
    expect(isUniqueViolation(null, SLUG_UNIQUE)).toBe(false);
    expect(isUniqueViolation({ code: "23502" }, SLUG_UNIQUE)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isUniqueViolation, RELEASE_READY_UNIQUE, SLUG_UNIQUE } from "./unique-violation.js";

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

describe("isUniqueViolation — versions release partial unique index (deployment coordination)", () => {
  it("matches the better-sqlite3 composite-index message", () => {
    const err = Object.assign(
      new Error("UNIQUE constraint failed: versions.canvas_id, versions.release_id"),
      { code: "SQLITE_CONSTRAINT_UNIQUE" },
    );
    expect(isUniqueViolation(err, RELEASE_READY_UNIQUE)).toBe(true);
  });

  it("matches the postgres constraint name, also when nested under .cause", () => {
    const direct = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "versions_canvas_release_ready_uq"',
      ),
      { code: "23505", constraint: "versions_canvas_release_ready_uq" },
    );
    expect(isUniqueViolation(direct, RELEASE_READY_UNIQUE)).toBe(true);
    const wrapped = Object.assign(new Error("Failed query: update versions …"), {
      cause: { code: "23505", constraint: "versions_canvas_release_ready_uq", message: "dup" },
    });
    expect(isUniqueViolation(wrapped, RELEASE_READY_UNIQUE)).toBe(true);
  });

  it("does NOT mistake the (canvas_id, number) index for the release index", () => {
    const sqliteErr = Object.assign(
      new Error("UNIQUE constraint failed: versions.canvas_id, versions.number"),
      { code: "SQLITE_CONSTRAINT_UNIQUE" },
    );
    const pgErr = Object.assign(new Error("dup"), {
      code: "23505",
      constraint: "versions_canvas_number_uq",
    });
    expect(isUniqueViolation(sqliteErr, RELEASE_READY_UNIQUE)).toBe(false);
    expect(isUniqueViolation(pgErr, RELEASE_READY_UNIQUE)).toBe(false);
  });
});

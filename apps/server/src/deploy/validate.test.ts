import { describe, expect, it } from "vitest";
import { DeployError } from "./errors.js";
import { normalizeEntryPath } from "./validate.js";

describe("normalizeEntryPath", () => {
  it("normalizes leading ./ and backslashes", () => {
    expect(normalizeEntryPath("./index.html")).toBe("index.html");
    expect(normalizeEntryPath("a\\b\\c.js")).toBe("a/b/c.js");
    expect(normalizeEntryPath("nested/app.js")).toBe("nested/app.js");
  });

  it("rejects path traversal (zip-slip)", () => {
    expect(() => normalizeEntryPath("../escape.txt")).toThrowError(DeployError);
    expect(() => normalizeEntryPath("a/../../etc/passwd")).toThrowError(/ZIP_SLIP|escape/i);
  });

  it("strips dotfiles and dot-dirs", () => {
    expect(normalizeEntryPath(".env")).toBeNull();
    expect(normalizeEntryPath(".git/config")).toBeNull();
    expect(normalizeEntryPath("src/.DS_Store")).toBeNull();
  });

  it("drops empty and directory-marker entries", () => {
    expect(normalizeEntryPath("")).toBeNull();
    expect(normalizeEntryPath("assets/")).toBeNull();
  });
});

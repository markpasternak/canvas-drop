import { loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import { isAdminEmail, isEmailDomainAllowed, mapIdentityToUser } from "./identity-mapping.js";

const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_DEV_USER_EMAIL: "x@example.com",
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_ADMIN_EMAILS: "mark@example.com",
});

describe("isEmailDomainAllowed", () => {
  it("accepts allowed domains and rejects others", () => {
    expect(isEmailDomainAllowed("a@example.com", config)).toBe(true);
    expect(isEmailDomainAllowed("a@evil.org", config)).toBe(false);
    expect(isEmailDomainAllowed("no-at-sign", config)).toBe(false);
  });
});

describe("isAdminEmail", () => {
  it("matches admin emails case-insensitively", () => {
    expect(isAdminEmail("mark@example.com", config)).toBe(true);
    expect(isAdminEmail("MARK@EXAMPLE.COM", config)).toBe(true);
    expect(isAdminEmail("other@example.com", config)).toBe(false);
  });
});

describe("mapIdentityToUser", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("upserts the user, lowercases email, and applies the admin bootstrap", async () => {
    client = await makeTestDb("sqlite");
    const repo = usersRepository(client);
    const user = await mapIdentityToUser(
      repo,
      { sub: "s1", email: "Mark@Example.com", name: "Mark" },
      config,
    );
    expect(user.email).toBe("mark@example.com");
    expect(user.isAdmin).toBe(true);

    // second call reuses the same row
    const again = await mapIdentityToUser(repo, { sub: "s1", email: "Mark@Example.com" }, config);
    expect(again.id).toBe(user.id);
  });
});

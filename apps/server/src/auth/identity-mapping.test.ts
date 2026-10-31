import { loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import {
  claimsToIdentity,
  isAdminEmail,
  isEmailDomainAllowed,
  mapIdentityToUser,
  userStillAdmitted,
} from "./identity-mapping.js";

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

describe("claimsToIdentity", () => {
  it("namespaces the subject by trust source and maps optional name/avatar", () => {
    expect(
      claimsToIdentity(
        { sub: "abc123", email: "Ada@example.com", name: "Ada", picture: "https://img/a.png" },
        "oidc",
      ),
    ).toEqual({
      sub: "oidc:abc123",
      email: "Ada@example.com",
      name: "Ada",
      avatarUrl: "https://img/a.png",
    });
  });

  it("falls back to the email as the subject when sub is empty or absent", () => {
    expect(claimsToIdentity({ sub: "", email: "a@example.com" }, "oidc")?.sub).toBe(
      "oidc:a@example.com",
    );
    expect(claimsToIdentity({ email: "a@example.com" }, "proxy")?.sub).toBe("proxy:a@example.com");
  });

  it("returns null when there is no usable email claim", () => {
    expect(claimsToIdentity({ sub: "abc" }, "oidc")).toBeNull();
    expect(claimsToIdentity({ sub: "abc", email: 42 }, "oidc")).toBeNull();
  });

  it("omits optional name/avatar when missing or non-string", () => {
    expect(
      claimsToIdentity({ sub: "s", email: "a@example.com", name: 5, picture: {} }, "oidc"),
    ).toEqual({ sub: "oidc:s", email: "a@example.com", name: undefined, avatarUrl: undefined });
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

describe("userStillAdmitted (realtime liveness)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("drops a user whose individual sign-in permit was removed, or who is blocked", async () => {
    client = await makeTestDb("sqlite");
    const repo = usersRepository(client);
    const outsider = await repo.upsert({
      providerSub: "s-out",
      email: "guest@outside.org",
      name: "Guest",
      isAdmin: false,
    });
    const member = await repo.upsert({
      providerSub: "s-in",
      email: "a@example.com",
      name: "A",
      isAdmin: false,
    });
    let permitted = true;
    const live = userStillAdmitted(repo, { isAllowed: async () => permitted }, config);

    expect(await live(outsider.id)).toBe(true);
    permitted = false; // the admin removes the permit
    expect(await live(outsider.id)).toBe(false);
    // Domain-admitted members don't depend on the permit list.
    expect(await live(member.id)).toBe(true);
    await repo.setBlocked(member.id, true);
    expect(await live(member.id)).toBe(false);
    expect(await live("no-such-user")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { bearerToken, generateApiKey, hashApiKey, looksLikeApiKey } from "./api-key.js";

describe("api-key", () => {
  it("generates a cd_-prefixed key and stores only its hash", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^cd_[A-Za-z0-9_-]+$/);
    const hash = hashApiKey(key);
    expect(hash).not.toBe(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha-256 hex
    expect(hashApiKey(key)).toBe(hash); // deterministic
  });

  it("detects key-shaped strings (deploy-time lint)", () => {
    const key = generateApiKey();
    expect(looksLikeApiKey(`const k = "${key}"`)).toBe(true);
    expect(looksLikeApiKey("no key here")).toBe(false);
    expect(looksLikeApiKey("cd_short")).toBe(false);
  });

  it("extracts a Bearer token", () => {
    expect(bearerToken("Bearer cd_abc")).toBe("cd_abc");
    expect(bearerToken("bearer cd_abc")).toBe("cd_abc");
    expect(bearerToken("Basic xyz")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

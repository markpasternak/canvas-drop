import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretCipher, SecretCipherError } from "./secret-cipher.js";

const key = () => randomBytes(32).toString("base64");

describe("connection protected-header cipher", () => {
  it("round-trips a header map through a versioned authenticated envelope", () => {
    const cipher = createSecretCipher(key());
    const envelope = cipher.encrypt("profile-1", {
      Authorization: "Bearer secret",
      "X-Vendor-Key": "abc123",
    });

    expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(envelope).not.toContain("secret");
    expect(cipher.decrypt("profile-1", envelope)).toEqual({
      Authorization: "Bearer secret",
      "X-Vendor-Key": "abc123",
    });
  });

  it("uses the profile id as authenticated data", () => {
    const cipher = createSecretCipher(key());
    const envelope = cipher.encrypt("profile-1", { Authorization: "Bearer secret" });
    expect(() => cipher.decrypt("profile-2", envelope)).toThrowError(
      expect.objectContaining({ code: "CONNECTION_SECRET_INVALID" }),
    );
  });

  it("fails closed for tampered or wrong-key envelopes without leaking values", () => {
    const envelope = createSecretCipher(key()).encrypt("profile-1", {
      Authorization: "Bearer do-not-leak",
    });
    for (const candidate of [`${envelope}x`, envelope.replace(/^v1\./, "v2.")]) {
      try {
        createSecretCipher(key()).decrypt("profile-1", candidate);
        expect.unreachable("decryption should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(SecretCipherError);
        expect((error as Error).message).not.toContain("do-not-leak");
      }
    }
  });

  it.each([undefined, "not base64", Buffer.alloc(31).toString("base64")])(
    "refuses protected-header operations with an unavailable or invalid key: %s",
    (configuredKey) => {
      const cipher = createSecretCipher(configuredKey);
      expect(cipher.available).toBe(false);
      expect(() => cipher.encrypt("profile-1", { Authorization: "secret" })).toThrowError(
        expect.objectContaining({ code: "CONNECTION_KEY_UNAVAILABLE" }),
      );
    },
  );
});

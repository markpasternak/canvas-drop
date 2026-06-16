import { describe, expect, it } from "vitest";
import { mintCaptureToken, verifyCaptureToken } from "./capture-token.js";

const SECRET = "test-session-secret-at-least-32-chars-long";
const CANVAS = "0190a000-0000-7000-8000-000000000001";
const VERSION = "0190b000-0000-7000-8000-0000000000a1";

describe("capture token (plan 004 / U3)", () => {
  // Rejection paths first (auth-invariant checklist: test the gate, not just the happy path).
  describe("rejection paths", () => {
    it("rejects a missing/empty token", () => {
      expect(verifyCaptureToken(SECRET, undefined)).toBeNull();
      expect(verifyCaptureToken(SECRET, null)).toBeNull();
      expect(verifyCaptureToken(SECRET, "")).toBeNull();
    });

    it("rejects a malformed token (no signature segment)", () => {
      expect(verifyCaptureToken(SECRET, "not-a-token")).toBeNull();
      expect(verifyCaptureToken(SECRET, "abc.")).toBeNull();
      expect(verifyCaptureToken(SECRET, ".abc")).toBeNull();
    });

    it("rejects a token signed with a different secret", () => {
      const token = mintCaptureToken("other-secret-also-32-chars-minimum-x", CANVAS, VERSION, 60_000);
      expect(verifyCaptureToken(SECRET, token)).toBeNull();
    });

    it("rejects a token whose payload was tampered with (signature mismatch)", () => {
      const token = mintCaptureToken(SECRET, CANVAS, VERSION, 60_000);
      const [, sig] = token.split(".");
      const forgedPayload = Buffer.from(
        JSON.stringify({ canvasId: "evil", versionId: VERSION, exp: Date.now() + 60_000 }),
        "utf8",
      ).toString("base64url");
      expect(verifyCaptureToken(SECRET, `${forgedPayload}.${sig}`)).toBeNull();
    });

    it("rejects an expired token", () => {
      const now = 1_000_000;
      const token = mintCaptureToken(SECRET, CANVAS, VERSION, 1000, now);
      // 2s later the 1s token is expired.
      expect(verifyCaptureToken(SECRET, token, now + 2000)).toBeNull();
    });
  });

  describe("happy path", () => {
    it("round-trips the scoped claims", () => {
      const now = 1_000_000;
      const token = mintCaptureToken(SECRET, CANVAS, VERSION, 60_000, now);
      const claims = verifyCaptureToken(SECRET, token, now + 1000);
      expect(claims).not.toBeNull();
      expect(claims?.canvasId).toBe(CANVAS);
      expect(claims?.versionId).toBe(VERSION);
      expect(claims?.exp).toBe(now + 60_000);
    });

    it("a token is bound to its exact canvas+version (different scope => different token)", () => {
      const a = mintCaptureToken(SECRET, CANVAS, VERSION, 60_000, 1000);
      const b = mintCaptureToken(SECRET, CANVAS, "different-version", 60_000, 1000);
      expect(a).not.toBe(b);
    });
  });
});

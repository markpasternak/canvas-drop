import { generateSessionToken, hashToken } from "../db/repositories/sessions.js";

/**
 * Upload-session handle (plan 003). The plaintext `uploadId` is returned to the
 * caller once at `begin`; only its SHA-256 (`handleHash`) is stored. High-entropy
 * and single-use, reusing the foundation's session-token primitives. The `up_`
 * prefix mirrors the `cd_` deploy-key convention (greppable, self-describing).
 */
const PREFIX = "up_";

export function generateUploadId(): string {
  return PREFIX + generateSessionToken();
}

/** SHA-256 of the uploadId (stored as `handle_hash`). */
export function hashUploadId(uploadId: string): string {
  return hashToken(uploadId);
}

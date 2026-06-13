import { randomBytes } from "node:crypto";
import { hashToken } from "../db/repositories/sessions.js";

/**
 * Canvas secret API key (§6.9.5, §11.4). Format `cd_<base64url-32B>` — the `cd_`
 * prefix makes keys greppable for the deploy-time lint that warns when a
 * key-shaped string appears in canvas files (§12.1.2). Only the SHA-256 hash is
 * stored (reusing the foundation's `hashToken`); the raw key is shown once.
 */
const PREFIX = "cd_";

export function generateApiKey(): string {
  return PREFIX + randomBytes(32).toString("base64url");
}

/** SHA-256 of the key (stored as `api_key_hash`). */
export function hashApiKey(key: string): string {
  return hashToken(key);
}

/** Whether a string looks like a canvas API key (for the deploy-time lint). */
export function looksLikeApiKey(s: string): boolean {
  return /\bcd_[A-Za-z0-9_-]{40,}\b/.test(s);
}

/** Extract a Bearer token from an Authorization header value. */
export function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader);
  return m?.[1] ?? null;
}

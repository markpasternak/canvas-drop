import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Internal capture credential (plan 004 / U3, §12.0).
 *
 * A stateless, server-minted HMAC token that authorizes the screenshot worker to
 * render exactly ONE canvas at ONE version for a short window. It is presented to
 * the canvas-serve layer as an internal request header; a middleware verifies it
 * server-side and sets a `capture` principal. Identity therefore originates
 * server-side (§12.0 #1) — the token is never client-supplied on a public surface,
 * never a user session, and grants no capability beyond what the canvas owner
 * already sees (enforced in `decideCanvasAccess`).
 *
 * Format: `base64url(payloadJson).base64url(hmacSha256(payloadJson))`, signed with
 * the configured session secret. No persistence (the signature IS the proof);
 * scope + expiry live in the signed payload.
 */
export interface CaptureClaims {
  canvasId: string;
  versionId: string;
  /** Absolute expiry, epoch ms. */
  exp: number;
}

/** Audit action names for the capture credential lifecycle (emitted by the worker, U5). */
export const CAPTURE_AUDIT_MINT = "capture_token_mint";
export const CAPTURE_AUDIT_RENDER = "capture_render";

/** Internal request header carrying the capture token. */
export const CAPTURE_TOKEN_HEADER = "x-canvas-drop-capture";

function sign(secret: string, payloadB64: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** Mint a capture token scoped to one canvas + version, valid for `ttlMs`. */
export function mintCaptureToken(
  secret: string,
  canvasId: string,
  versionId: string,
  ttlMs: number,
  now: number = Date.now(),
): string {
  const claims: CaptureClaims = { canvasId, versionId, exp: now + ttlMs };
  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payloadB64}.${sign(secret, payloadB64)}`;
}

/**
 * Verify a capture token: signature must match (constant-time) AND it must not be
 * expired. Returns the scoped claims, or null on ANY failure (malformed, tampered
 * payload, bad signature, expired). The caller maps a non-null result to a
 * `capture` principal scoped to `claims.canvasId` — the canvas binding is enforced
 * downstream in `decideCanvasAccess`, never trusted from the request target.
 */
export function verifyCaptureToken(
  secret: string,
  token: string | undefined | null,
  now: number = Date.now(),
): CaptureClaims | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(secret, payloadB64);
  const sigBuf = Buffer.from(sig, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  // Length-guard before timingSafeEqual (it throws on length mismatch).
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  let claims: CaptureClaims;
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed.canvasId !== "string" ||
      typeof parsed.versionId !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    claims = parsed;
  } catch {
    return null;
  }

  if (claims.exp <= now) return null;
  return claims;
}

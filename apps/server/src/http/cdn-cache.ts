/**
 * Shared-cache (CDN/proxy) policy for canvas content. One module owns both the
 * `Cache-Control` we emit and the human-readable staleness figure we warn owners
 * about on an access downgrade, so the header and the warning can never disagree
 * (see canvas/serve.ts and canvas/settings-update.ts).
 *
 * The load-bearing rule: only an *anonymously public* canvas — the `public_link`
 * rung with no password gate, the single rung an unauthenticated request can reach
 * (canvas/authorization.ts) — may carry `public` cacheability. Every auth-gated rung
 * is `private`, so a shared cache in front never stores one viewer's bytes and
 * replays them to another (§12.0 / §12.2 isolation), regardless of TTL config.
 */

const IMMUTABLE_MAX_AGE = 31_536_000; // 1 year — content-hashed assets never change.

export interface CanvasCachePolicy {
  /** Filename is content-hashed (e.g. `app.a1b2c3d4.js`) → safe to cache forever. */
  contentHashed: boolean;
  /** `public_link` rung AND no password gate — reachable by an anonymous request. */
  anonymouslyPublic: boolean;
  /** Shared-cache TTL (seconds) for public HTML; 0 disables shared caching. */
  edgeTtlSec: number;
}

/**
 * Build the `Cache-Control` for a canvas asset.
 *
 * - Content-hashed assets: `max-age=1y, immutable`, `public` only when the canvas is
 *   anonymously public (else `private` so a CDN won't store an auth-gated asset).
 * - HTML / unhashed paths: always `max-age=0` so the *browser* revalidates every
 *   load (instant access changes for the viewer). A shared cache may hold it for
 *   `s-maxage` ONLY when the canvas is anonymously public and `edgeTtlSec > 0`;
 *   otherwise `private, no-cache` keeps it off shared caches entirely.
 */
export function canvasCacheControl(policy: CanvasCachePolicy): string {
  const { contentHashed, anonymouslyPublic, edgeTtlSec } = policy;
  if (contentHashed) {
    const scope = anonymouslyPublic ? "public" : "private";
    return `${scope}, max-age=${IMMUTABLE_MAX_AGE}, immutable`;
  }
  if (anonymouslyPublic && edgeTtlSec > 0) {
    // Browser revalidates (max-age=0); a shared cache may serve from edge for s-maxage.
    return `public, max-age=0, s-maxage=${edgeTtlSec}`;
  }
  // Anonymously public but edge caching off → public revalidation is fine. Auth-gated
  // → private so no shared cache ever stores it.
  return anonymouslyPublic ? "public, no-cache" : "private, no-cache";
}

/**
 * The shared-cache TTL to actually emit for a public canvas, clamped so a CDN can
 * never keep serving it past its share expiry. With no expiry it's the configured
 * TTL; with one, it's `min(configured, secondsUntilExpiry)` and never negative. (An
 * already-expired share isn't anonymously public at all — see isAnonymouslyPublic —
 * so this only narrows the window for a share expiring within the TTL.)
 */
export function effectiveEdgeTtlSec(
  configTtlSec: number,
  sharedExpiresAt: number | null,
  now: number,
): number {
  if (sharedExpiresAt === null) return configTtlSec;
  const secondsUntilExpiry = Math.max(0, Math.floor((sharedExpiresAt - now) / 1000));
  return Math.min(configTtlSec, secondsUntilExpiry);
}

/**
 * Plain-language duration for owner-facing copy ("about 5 minutes"). Rounds to the
 * coarsest sensible unit; callers use it to tell a non-technical owner how long a
 * CDN may keep showing a canvas after they restrict it.
 */
export function humanizeDuration(totalSeconds: number): string {
  const sec = Math.max(0, Math.round(totalSeconds));
  if (sec < 60) return sec === 1 ? "about a second" : `about ${sec} seconds`;
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

/**
 * Warning shown when an owner moves a canvas OFF the anonymously-public rung while
 * shared caching is enabled — the page can linger at a CDN edge for up to the TTL.
 * Returns null when there's nothing to warn about (edge caching off). The wording is
 * deliberately conditional ("if you serve through a CDN") because the server can't
 * know whether one is actually deployed in front of it.
 */
export function cdnAccessDowngradeWarning(edgeTtlSec: number): string | null {
  if (edgeTtlSec <= 0) return null;
  return (
    `If you serve this instance through a CDN, this canvas may stay visible at the ` +
    `CDN's edge cache for up to ${humanizeDuration(edgeTtlSec)} after this change, ` +
    `until the cached copy expires.`
  );
}

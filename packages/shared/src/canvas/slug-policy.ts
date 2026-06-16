/**
 * Slug policy — the single source of truth for what a canvas slug may be.
 *
 * Pure string logic with NO node imports, so it stays bundle-safe for any future
 * browser consumer. The server is the authority (it calls {@link validateSlug}
 * before insert and layers DB uniqueness on top); a client may use
 * {@link normalizeSlug} for a cosmetic preview only.
 *
 * Grammar is DNS-label-safe (BUILD_BRIEF.md §8.2) so a slug behaves identically
 * in path mode (`/c/{slug}/`) and subdomain mode (`{slug}.{host}`): lowercase
 * `a–z`, digits, and hyphen; length 1–63; no leading/trailing hyphen; not a
 * reserved word. The readable-random generator (`apps/server/src/canvas/slug.ts`)
 * already produces strings that satisfy this grammar.
 */

/** Max DNS label length, also our slug length cap. */
export const SLUG_MAX_LENGTH = 63;

/**
 * Words a custom slug may not take, because they would shadow a real route or
 * platform surface in subdomain mode (where the slug IS the host label).
 *
 * Reconciled against `apps/server/src/app.ts` top-level mounts plus the SPA's
 * `RESERVED_API_PREFIXES`, plus conventional infrastructure subdomains. The
 * deployment layer (Caddy/DNS) is the real subdomain authority and lives outside
 * this repo, so this is a deliberately conservative curated superset. Entries
 * containing a `.` (e.g. `og.png`, `skill.zip`) can never be a slug — the grammar
 * rejects dots — so only bare single-label routes need listing here.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Mounted API / auth / asset prefixes (RESERVED_API_PREFIXES + friends).
  "api",
  "v1",
  "sdk",
  "auth",
  "mcp",
  // Bare top-level routes in app.ts (would be shadowed as subdomains).
  "healthz",
  "welcome",
  "docs",
  "gallery",
  "privacy",
  "terms",
  "skill",
  // Conventional infrastructure / platform subdomains.
  "www",
  "app",
  "admin",
  "mail",
  "static",
  "assets",
]);

/**
 * Cosmetically coerce arbitrary input toward a valid slug shape for live preview:
 * lowercase, collapse any run of disallowed characters to a single hyphen, and
 * trim leading/trailing hyphens. NOT authoritative — the server still validates.
 */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Why a slug failed validation. `taken` is layered on by the caller (DB), not here. */
export type SlugInvalidReason = "invalid" | "reserved";

export type SlugValidation = { ok: true } | { ok: false; reason: SlugInvalidReason };

/**
 * Validate a slug against the grammar and the reserved list. Uniqueness is the
 * caller's concern (a DB lookup + the `canvases_slug_uq` index).
 */
export function validateSlug(slug: string): SlugValidation {
  if (slug.length < 1 || slug.length > SLUG_MAX_LENGTH) return { ok: false, reason: "invalid" };
  // Allowed chars only, and no leading/trailing hyphen. A single char must be alnum.
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return { ok: false, reason: "invalid" };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: "reserved" };
  return { ok: true };
}

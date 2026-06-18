/**
 * Cosmetic, client-only slug helpers (plan 004). The dashboard does NOT import
 * `@canvas-drop/shared` (bundle safety — KTD2), so this mirrors the server's
 * normalization *for preview only*. The server's `validateSlug` + the availability
 * endpoint remain the authority; this just shapes the live preview as the user types.
 */

/**
 * Whether a canvas path param is a canvas id (UUIDv7) rather than a cosmetic slug.
 * Canvas ids are 36-char hyphenated UUIDs (8-4-4-4-12); slugs are short
 * lowercase-alphanumeric-and-hyphen labels (e.g. `quiet-otter`). Used by the canvas
 * detail route to decide whether to attempt a slug → id resolution before 404ing.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isCanvasId(param: string): boolean {
  return UUID_RE.test(param);
}

/** Lowercase, collapse runs of invalid chars to a hyphen, trim edge hyphens. */
export function cosmeticSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build the preview URL a slug would resolve to, per the instance's URL mode. */
export function slugPreviewUrl(
  slug: string,
  instance: { urlMode: "path" | "subdomain"; baseUrl: string },
): string {
  const base = instance.baseUrl.replace(/\/$/, "");
  if (instance.urlMode === "subdomain") {
    try {
      const u = new URL(base);
      return `${u.protocol}//${slug}.${u.host}/`;
    } catch {
      return `${slug}.${base}`;
    }
  }
  return `${base}/c/${slug}/`;
}

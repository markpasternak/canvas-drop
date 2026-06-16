/**
 * Cosmetic, client-only slug helpers (plan 004). The dashboard does NOT import
 * `@canvas-drop/shared` (bundle safety — KTD2), so this mirrors the server's
 * normalization *for preview only*. The server's `validateSlug` + the availability
 * endpoint remain the authority; this just shapes the live preview as the user types.
 */

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

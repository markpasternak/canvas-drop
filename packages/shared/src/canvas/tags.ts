/**
 * Canvas tag policy — the single source of truth for the per-canvas tag invariants.
 *
 * Pure constants with NO node imports, so they stay bundle-safe for any consumer
 * (server validation schemas, the gallery + owner tag-filter routes, the MCP tool
 * schema). The server is the authority: it caps the stored `tags` array at write time
 * and clamps tag-filter query params to the same bound, so a filter past the cap adds
 * cost with no new matches.
 */

/** Max tags one canvas may carry (and thus the most a tag filter can usefully take). */
export const CANVAS_MAX_TAGS = 20;

/** Max length of a single tag string. */
export const CANVAS_MAX_TAG_LENGTH = 50;

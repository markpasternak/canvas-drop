import { validateSlug } from "@canvas-drop/shared";
import type { Canvas, CanvasSlugAlias } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import { ALIAS_UNIQUE, isUniqueViolation, SLUG_UNIQUE } from "../db/unique-violation.js";
import { resolveCreateSlug } from "./slug.js";

/**
 * Slug changes and aliases (plan 2026-10-30-1815). One service shared by the
 * management routes and the MCP tools so both apply the same validation, cap,
 * audit and socket-drop rules (agent-native parity). Callers have already passed
 * the role gate (`set_canvas_slug`'s editor minimum).
 */

/** Most aliases one canvas may carry (decided with the owner, plan KTD-cap). */
export const MAX_SLUG_ALIASES = 10;

export type SlugChangeError = "invalid_slug" | "slug_taken" | "alias_limit";

export interface SlugAliasDeps {
  canvases: Pick<
    CanvasesRepository,
    | "slugTaken"
    | "canonicalSlugTaken"
    | "listAliases"
    | "addAlias"
    | "removeAlias"
    | "regenerateSlug"
  >;
  audit: Pick<AuditLog, "recordAudit">;
  hub?: { dropCanvas(canvasId: string): void } | null;
}

/**
 * Change a canvas's canonical slug. `slug` empty/absent → fresh random slug; one of the
 * canvas's own aliases → promote it; otherwise a new custom slug. `keepOldAsAlias` keeps
 * the outgoing slug answering (as a redirect). Live sockets drop either way: their origin
 * (subdomain mode) or path (path mode) is the old slug.
 */
export async function renameCanvasSlug(
  deps: SlugAliasDeps,
  canvas: Canvas,
  input: { slug?: string; keepOldAsAlias?: boolean },
  actorId: string,
): Promise<{ canvas: Canvas } | { error: SlugChangeError }> {
  const requested = input.slug?.trim();
  const aliases = await deps.canvases.listAliases(canvas.id);
  const promote = !!requested && aliases.some((a) => a.slug === requested);

  let target: { slug: string; custom: boolean };
  if (promote) {
    target = { slug: requested, custom: true };
  } else if (requested === canvas.slug) {
    // Renaming to the current slug is a no-op write (today's behaviour), never "taken".
    target = { slug: canvas.slug, custom: true };
  } else {
    const resolved = await resolveCreateSlug(requested, (s) =>
      deps.canvases.slugTaken(s, { ownerId: canvas.ownerId, canvasId: canvas.id }),
    );
    if ("error" in resolved) return { error: resolved.error };
    target = resolved;
  }

  const keepOld = !!input.keepOldAsAlias && target.slug !== canvas.slug;
  const after = aliases.length - (promote ? 1 : 0) + (keepOld ? 1 : 0);
  if (keepOld && after > MAX_SLUG_ALIASES) return { error: "alias_limit" };

  let updated: Canvas;
  try {
    updated = await deps.canvases.regenerateSlug(canvas.id, target.slug, target.custom, {
      promote,
      keepOld: keepOld ? { slug: canvas.slug, createdBy: actorId } : undefined,
    });
  } catch (err) {
    if (isUniqueViolation(err, SLUG_UNIQUE) || isUniqueViolation(err, ALIAS_UNIQUE)) {
      return { error: "slug_taken" };
    }
    throw err;
  }
  deps.audit.recordAudit({
    action: "slug_regen",
    actorId,
    targetId: canvas.id,
    ...(promote || keepOld ? { meta: { promotedAlias: promote, keptOldAsAlias: keepOld } } : {}),
  });
  // Old slug URLs are invalidated (or now redirect) — drop all live sockets so clients
  // reconnect under the new slug (D-RT-6 / §12.0 #5).
  deps.hub?.dropCanvas(canvas.id);
  return { canvas: updated };
}

/** Add an alias. Same grammar and namespace as a canonical slug (KTD5). */
export async function addCanvasAlias(
  deps: SlugAliasDeps,
  canvas: Canvas,
  rawSlug: string,
  actorId: string,
): Promise<{ alias: CanvasSlugAlias } | { error: SlugChangeError }> {
  const slug = rawSlug.trim();
  if (!validateSlug(slug).ok) return { error: "invalid_slug" };
  const aliases = await deps.canvases.listAliases(canvas.id);
  if (slug === canvas.slug || aliases.some((a) => a.slug === slug)) {
    return { error: "slug_taken" };
  }
  if (aliases.length >= MAX_SLUG_ALIASES) return { error: "alias_limit" };
  if (await deps.canvases.slugTaken(slug, { ownerId: canvas.ownerId, canvasId: canvas.id })) {
    return { error: "slug_taken" };
  }

  let alias: CanvasSlugAlias;
  try {
    alias = await deps.canvases.addAlias({ canvasId: canvas.id, slug, createdBy: actorId });
  } catch (err) {
    if (isUniqueViolation(err, ALIAS_UNIQUE)) return { error: "slug_taken" };
    throw err;
  }
  // The two unique indexes can't see each other: a canvas created with this exact slug
  // between our check and insert would win every lookup anyway, but give the name back
  // rather than hold a dead alias.
  if (await deps.canvases.canonicalSlugTaken(slug)) {
    await deps.canvases.removeAlias(canvas.id, slug);
    return { error: "slug_taken" };
  }
  deps.audit.recordAudit({
    action: "slug_alias_add",
    actorId,
    targetId: canvas.id,
    meta: { slug },
  });
  return { alias };
}

/** Remove an alias; the name stays reserved for this canvas and its owner for a while. */
export async function removeCanvasAlias(
  deps: SlugAliasDeps,
  canvas: Canvas,
  slug: string,
  actorId: string,
): Promise<boolean> {
  const removed = await deps.canvases.removeAlias(canvas.id, slug);
  if (removed) {
    deps.audit.recordAudit({
      action: "slug_alias_remove",
      actorId,
      targetId: canvas.id,
      meta: { slug },
    });
  }
  return removed;
}

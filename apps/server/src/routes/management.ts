import { Buffer } from "node:buffer";
import {
  CANVAS_MAX_TAG_LENGTH,
  CANVAS_MAX_TAGS,
  type CapabilityGlobals,
  type Config,
  effectiveCapabilities,
  storedCapabilities,
  validateSlug,
} from "@canvas-drop/shared";
import type { Canvas, CanvasStatus, Manifest } from "@canvas-drop/shared/db";
import { publicationState } from "@canvas-drop/shared/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AuditLog } from "../audit/audit-log.js";
import type { GuestService } from "../auth/guest.js";
import { resolveAllowlistEntries } from "../canvas/allowlist-view.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import type { CloneService } from "../canvas/clone-service.js";
import { rootEntry } from "../canvas/manifest.js";
import { classifyMutability, disabledError, requireOwnedCanvas } from "../canvas/owner-guard.js";
import { hashPassword } from "../canvas/password.js";
import { resolveSettingsUpdate } from "../canvas/settings-update.js";
import { resolveCreateSlug } from "../canvas/slug.js";
import { SCREENSHOT_RENDITIONS, screenshotKey } from "../canvas/storage-keys.js";
import { canvasUrl } from "../canvas/url.js";
import { fetchCanvasUsage } from "../canvas/usage-stats.js";
import type { AiUsageRepository } from "../db/repositories/ai-usage.js";
import {
  type CanvasesRepository,
  CLEARED_PUBLICATION_FIELDS,
  POPULAR_WINDOW_MS,
} from "../db/repositories/canvases.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { InvitationsRepository } from "../db/repositories/invitations.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { isUniqueViolation, SLUG_UNIQUE } from "../db/unique-violation.js";
import type { DeployEngine } from "../deploy/engine.js";
import { DeployError } from "../deploy/errors.js";
import { type DeployEntry, fromPasteHtml, fromZip } from "../deploy/ingest.js";
import { requireSameOrigin } from "../http/same-origin.js";
import type { AppEnv } from "../http/types.js";
import type { InviteService } from "../invites/service.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { encodeRenditions } from "../screenshots/capture.js";
import { deletePreviewRenditions } from "../screenshots/custom-preview.js";
import {
  type PreviewHintDeps,
  previewVisible,
  resolvePreviewIds,
} from "../screenshots/preview-ids.js";
import type { StorageDriver } from "../storage/driver.js";
import { listSharedWithTeams, resolveTeamGrant } from "../teams/sharing.js";
import { resolveHomeOrg } from "../tenancy/home-org.js";
import { blobBodyLimit, deployBodyLimit, deployResponse } from "./deploy-common.js";

export interface ManagementDeps extends PreviewHintDeps {
  /** Teams store (plan 003 U4/U5) — the canvas→team grant flow on PATCH /:id/settings,
   *  the current-grants read on the owner canvas view, and the "shared with my teams"
   *  list. Optional: suites that don't exercise the team rung may omit it. */
  teams?: Pick<
    TeamsRepository,
    | "findById"
    | "isTeamMember"
    | "setCanvasTeams"
    | "listTeamIdsForCanvas"
    | "listCanvasIdsForUserTeams"
    | "teamMatch"
  >;
  config: Config;
  canvases: CanvasesRepository;
  users: UsersRepository;
  versions: VersionsRepository;
  clone: CloneService;
  audit: AuditLog;
  engine: DeployEngine;
  /** Blob store — backs the custom-preview upload (PUT/DELETE /:id/preview). */
  storage: StorageDriver;
  usage: UsageEventsRepository;
  files: FilesRepository;
  aiUsage: AiUsageRepository;
  /**
   * Realtime hub for revoke-drops-socket (D-RT-6). Optional — when present, access-
   * changing mutations (settings, capabilities, disable, delete, slug regen) drop
   * live sockets that lost access; a newly-set password drops gated non-owners.
   */
  hub?: RealtimeHub;
  /** Legacy guest service. Kept only so revoking old access rows can revoke any
   *  retained guest sessions; new sharing never creates app-owned credentials. */
  guests?: GuestService;
  /**
   * Effective operator-global resolvers (admin DB override ?? env). Optional —
   * omitted in unit tests, which fall back to the boot `config` values. Used so
   * the `effective` capability state the dashboard reads reflects a runtime-set
   * AI key / realtime switch.
   */
  aiEnabled?: () => Promise<boolean>;
  realtimeEnabled?: () => Promise<boolean>;
  /** Effective instance-wide public-link gate. Omitted in focused tests: defaults on. */
  publicLinksEnabled?: () => Promise<boolean>;
  /** The invite primitive (plan 003 U8) — the individual one-off canvas invite routes through
   *  it. Optional: suites that don't exercise the invite path may omit it. */
  invites?: InviteService;
  invitations?: Pick<InvitationsRepository, "listPendingForTarget" | "cancelPendingForTarget">;
  // Screenshot preview hint (plan 004): `screenshotsEnabled` + `screenshots.doneCanvasIds`
  // come from PreviewHintDeps. Both optional — omitted in unit tests → `hasPreview` false.
}

const createSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  // Optional owner-chosen slug (plan 004). Absent/empty → readable-random. Grammar +
  // reserved-word + uniqueness are enforced below; the cap matches the slug length limit.
  slug: z.string().max(63).optional(),
  // Backend-group master switch chosen at create time (plan 006). Off by default.
  backendEnabled: z.boolean().optional(),
  // Home tenant (plan 002 U4): null/absent = personal (default to the caller's org if
  // they have exactly one); a non-null value is validated against the caller's membership.
  orgId: z.string().nullable().optional(),
});

/** Capability patch (plan 006). All fields optional booleans; absent = unchanged. */
const capabilitiesSchema = z.object({
  backendEnabled: z.boolean().optional(),
  kv: z.boolean().optional(),
  files: z.boolean().optional(),
  ai: z.boolean().optional(),
  realtime: z.boolean().optional(),
});

const settingsSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  // First-class access rung (D4). `public_link` is accepted here but rejected unless
  // the instance-wide switch is on and the owner's per-user capability has not been
  // revoked. `shared` remains a deprecated boolean alias (true→whole_org, false→private).
  access: z.enum(["private", "specific_people", "team", "whole_org", "public_link"]).optional(),
  // Teams to grant when access='team' (plan 003 U4). Owner may grant only teams they
  // belong to in this canvas's org (validated server-side at grant time, KTD4).
  teamIds: z.array(z.string().min(1)).max(50).optional(),
  // Guest-AI opt-in (U9): off by default; cap is a per-canvas monthly USD ceiling.
  guestAiEnabled: z.boolean().optional(),
  guestAiCap: z.number().min(0).optional(),
  shared: z.boolean().optional(),
  sharedExpiresAt: z.number().int().positive().nullable().optional(),
  password: z.string().min(1).nullable().optional(), // set, or null to clear
  spaFallback: z.boolean().optional(),
  // Preview policy: auto (screenshot on publish) or off (generative cover). `custom`
  // is set only by uploading an image via PUT /:id/preview, never through settings.
  previewMode: z.enum(["auto", "off"]).optional(),
  galleryListed: z.boolean().optional(),
  galleryTemplatable: z.boolean().optional(),
  tags: z.array(z.string().max(CANVAS_MAX_TAG_LENGTH)).max(CANVAS_MAX_TAGS).optional(),
});

/**
 * OWNER canvas view (never leaks `api_key_hash` / `password_hash`). Every
 * caller of this projection is gated by `ownedCanvas` (owner-only) or
 * `requireAdmin`, so it carries the owner-facing `disabledReason` (§6.10.2 — "owner
 * sees why"). It is NOT a public/shared projection: any future non-owner-facing
 * view (gallery, shared link) must be a SEPARATE function that omits `disabledReason`
 * and other owner-only fields.
 */
function ownerCanvasView(
  config: Config,
  cv: Canvas,
  globals: CapabilityGlobals,
  hasPreview = false,
  /** The teams this canvas is granted to (plan 003 U5) — only meaningful (and only
   *  resolved) when `access === 'team'`. Empty on the list path (no per-row join);
   *  populated on the single-canvas view so the share picker can pre-check them. */
  teamIds: string[] = [],
) {
  return {
    id: cv.id,
    slug: cv.slug,
    // A captured screenshot preview exists for this canvas (plan 004). Drives the
    // dashboard cover (real shot vs GenerativeCover) without a probe request. False
    // whenever the pipeline is off, so the dashboard behaves exactly like today.
    hasPreview,
    // Owner-chosen vs readable-random — drives the public+custom heads-up (plan 004).
    slugCustom: cv.slugCustom,
    url: canvasUrl(config, cv.slug),
    title: cv.title,
    description: cv.description,
    access: cv.access,
    // The teams this canvas is shared with (plan 003 U5). Empty unless access==='team'
    // (and only resolved on the single-canvas view; the list path leaves it []).
    teamIds,
    // Home tenant (plan 002): null = Personal, else the org id. The dashboard maps it to a
    // name via /api/me.orgs to show the scope badge + gate the org-only share controls.
    orgId: cv.orgId,
    // Back-compat boolean for the current dashboard (U4 switches it to read `access`).
    shared: cv.access !== "private",
    guestAiEnabled: cv.guestAiEnabled,
    guestAiCap: cv.guestAiCap,
    sharedExpiresAt: cv.sharedExpiresAt,
    hasPassword: cv.passwordHash !== null,
    spaFallback: cv.spaFallback,
    // Preview policy (plan 004): auto = screenshot on publish, off = generative cover,
    // custom = owner-uploaded image (survives publishes). Drives the settings control.
    previewMode: cv.previewMode,
    galleryListed: cv.galleryListed,
    galleryTemplatable: cv.galleryTemplatable,
    // tags is stored as JSON (Json | null); the API contract is string[] | null.
    tags: cv.tags as string[] | null,
    // Lineage (plan 002): the canvas this one was cloned from, for "Cloned from …".
    clonedFromCanvasId: cv.clonedFromCanvasId,
    // Capability model (plan 006): the master switch, the raw stored feature flags,
    // and the effective state after ANDing operator globals (so the dashboard can
    // explain a feature that's off because the operator disabled it).
    backendEnabled: cv.backendEnabled,
    capabilities: storedCapabilities(cv),
    // Effective state ANDs in the operator globals — resolved per request so an
    // admin's DB override of the AI key / realtime switch is reflected here too.
    effective: effectiveCapabilities(cv, globals),
    status: cv.status,
    // Single derived lifecycle (Draft/Published/Archived/Disabled) the dashboard
    // renders as the Publication chip — one authoritative value, never stored.
    publicationState: publicationState(cv.status as CanvasStatus, cv.currentVersionId !== null),
    // Admin takedown reason (§6.10.2, M7). Owner-only surface — see the doc above.
    disabledReason: cv.disabledReason,
    currentVersionId: cv.currentVersionId,
    // Denormalized view rollups (plan 004): lifetime deduped views + the last-viewed
    // stamp, both O(1) off the canvas row. The trending (recent-window) number used by
    // the list + the `popular` sort is added per-page as `recentViews` (list only).
    viewCount: cv.viewCount,
    lastViewedAt: cv.lastViewedAt,
    createdAt: cv.createdAt,
    updatedAt: cv.updatedAt,
  };
}

const CANVASES_PAGE_SIZE = 30;
const CANVASES_MAX_LIMIT = 100;

/** Coerce an optional query flag ("1"/"true" → true; absent/anything else → false). */
const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

/**
 * Your-canvases browse query (plan 005). Mirrors the gallery schema: invalid or
 * absent values clamp to defaults rather than 400ing, so a junk param still
 * renders the owner's list. `undeployed` is the URL param for the never-deployed
 * filter (maps to the repo's `neverDeployed`); `sort` falls back to `updated`.
 */
const ownerListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  // Multi-tag any-match (2026-06-19): repeated `?tag=a&tag=b`, read off
  // `c.req.queries("tag")` into a string[] (URL-shareable). Each tag trimmed; empties
  // dropped. An empty list adds no tag filter — same semantics as the gallery.
  tag: z.array(z.string().trim().min(1)).optional(),
  // Access-rung filter (D4); `shared` stays as the legacy coarse boolean. `.catch`
  // (like the sibling fields) so a junk ?access= drops only this filter, not the whole set.
  access: z
    .enum(["private", "specific_people", "team", "whole_org", "public_link"])
    .optional()
    .catch(undefined),
  shared: boolFlag,
  protected: boolFlag,
  listed: boolFlag,
  template: boolFlag,
  undeployed: boolFlag,
  // Lifecycle scope: the active set (default) or the archived set (Your-canvases
  // Active/Archived toggle). A junk value falls back to active.
  scope: z.enum(["active", "archived"]).catch("active"),
  sort: z.enum(["updated", "created", "title", "popular"]).catch("updated"),
  limit: z.coerce.number().int().catch(CANVASES_PAGE_SIZE),
  offset: z.coerce.number().int().catch(0),
});

/**
 * Canvas lifecycle management API (§11.3), mounted at `/api/canvases`. Owner (or
 * admin) authenticated via the foundation gateway; same-origin enforced on
 * mutating routes. Covers CRUD, settings, access/allowlist, capabilities,
 * deploy (paste/zip/folder), rollback, and lifecycle (archive/unarchive/unpublish).
 */
export function managementRoutes(deps: ManagementDeps) {
  const app = new Hono<AppEnv>();
  const sameOrigin = requireSameOrigin(deps.config);

  /** Resolve the operator globals for THIS request (admin DB override ?? env). */
  async function resolveGlobals(): Promise<CapabilityGlobals> {
    return {
      realtimeEnabled: deps.realtimeEnabled
        ? await deps.realtimeEnabled()
        : deps.config.realtimeEnabled,
      aiEnabled: deps.aiEnabled ? await deps.aiEnabled() : !!deps.config.ai.apiKey,
    };
  }
  /** Shared cosmetic preview-existence hint — gate + degrade live in one place
   *  ({@link resolvePreviewIds}); optional deps (omitted in unit tests) → no previews. */
  const previewIds = (canvasIds: string[]) => resolvePreviewIds(deps, canvasIds);

  /** Serialize one canvas with the per-request effective globals. */
  async function canvasView(cv: Canvas) {
    const hasPreview = previewVisible(cv, await previewIds([cv.id]));
    // Resolve the canvas's team grants only here (the single-canvas view) — the share
    // picker pre-checks them. The list path skips this join (teamIds stays []).
    const teamIds =
      deps.teams && cv.access === "team" ? await deps.teams.listTeamIdsForCanvas(cv.id) : [];
    return ownerCanvasView(deps.config, cv, await resolveGlobals(), hasPreview, teamIds);
  }

  /** Load a canvas the caller OWNS, else 404. Owner-only gate for the owner management
   *  surface, shared with draft-api.ts so the two can't drift. A non-owner admin is
   *  treated like any other member here (404); cross-owner admin power is the admin
   *  routes only (list + disable/enable/restore). */
  const ownedCanvas = (c: Context<AppEnv>) => requireOwnedCanvas(c, deps.canvases);

  /** Load a canvas the caller OWNS *and* may still mutate, else send the refusal.
   *  Returns the canvas, or a Response the handler must return as-is:
   *   - 404 (`{ error: "not_found" }`) when not owned / missing / deleted (no existence leak)
   *   - 409 (`{ code: "DISABLED", … }`) when an admin has taken the canvas down (§12.0 #5).
   *  A disabled canvas is read-only to its owner: every owner MUTATION goes through this,
   *  while reads keep using `ownedCanvas` so the owner can still see the canvas + reason. */
  const mutableCanvas = async (c: Context<AppEnv>): Promise<Canvas | Response> => {
    const outcome = classifyMutability(await ownedCanvas(c));
    switch (outcome.kind) {
      case "not-found":
        return c.json({ error: "not_found" }, 404);
      case "disabled":
        return c.json(disabledError(outcome.canvas), 409);
      case "ok":
        return outcome.canvas;
    }
  };

  /** Fire-and-forget realtime revalidation with a LOGGED swallow — a persistent
   *  hub failure (stale sockets after a settings change) is now observable. */
  const revalidate = async (c: Context<AppEnv>, canvasId: string) => {
    if (!deps.hub) return;
    await deps.hub
      .revalidateCanvas(canvasId)
      .catch((err) => c.get("log")?.warn({ err, canvasId }, "hub: revalidateCanvas failed"));
  };
  /** Guest-grant revocation with a LOGGED swallow at ERROR level — a silent
   *  failure means guests keep access after archive/delete/unpublish. */
  const revokeGuests = async (c: Context<AppEnv>, canvasId: string) => {
    if (!deps.guests) return;
    await deps.guests
      .revokeAllForCanvas(canvasId)
      .catch((err) => c.get("log")?.error({ err, canvasId }, "guests: revokeAllForCanvas failed"));
  };

  /** 409 body for deploy/rollback on a non-active (archived/disabled) canvas.
   *  Publishing to a canvas whose public URL 404s is incoherent — make the caller
   *  bring it back first. Settings/regenerate/delete stay allowed while archived. */
  const NOT_ACTIVE = {
    code: "NOT_ACTIVE",
    message: "Unarchive this canvas before deploying or changing its live version.",
  } as const;

  // Create → slug + API key (shown once).
  app.post("/", sameOrigin, async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const user = c.get("user");
    // Home tenant (plan 002 U4): validate any requested org against the caller's
    // server-resolved membership; default to their org when they have exactly one.
    const home = resolveHomeOrg(body.data.orgId, c.get("orgIds") ?? new Set<string>());
    if ("error" in home) return c.json({ error: home.error }, 403);
    const resolved = await resolveCreateSlug(body.data.slug, (s) => deps.canvases.slugTaken(s));
    if ("error" in resolved) return c.json({ error: resolved.error }, 400);
    const apiKey = generateApiKey();
    let cv: Canvas;
    try {
      cv = await deps.canvases.create({
        ownerId: user.id,
        slug: resolved.slug,
        slugCustom: resolved.custom,
        apiKeyHash: hashApiKey(apiKey),
        title: body.data.title,
        description: body.data.description,
        orgId: home.orgId,
        backendEnabled: body.data.backendEnabled,
      });
    } catch (err) {
      // A custom slug racing another insert loses against `canvases_slug_uq` (KTD7).
      if (resolved.custom && isUniqueViolation(err, SLUG_UNIQUE)) {
        return c.json({ error: "slug_taken" }, 409);
      }
      throw err;
    }
    deps.audit.recordAudit({ action: "canvas_create", actorId: user.id, targetId: cv.id });
    // apiKey is returned ONCE and never again.
    return c.json({ ...(await canvasView(cv)), apiKey }, 201);
  });

  // Clone → a new canvas owned by the caller, seeded from an existing one (plan 002).
  // An owner may clone any ACTIVE canvas they own; a non-owner only a gallery-listed
  // + templatable one. Eligibility is re-derived server-side from the row (never the
  // client); a non-eligible source 404s opaquely so its existence isn't revealed
  // (§12.2). The clone gets its OWN fresh deploy key (the source's is never copied),
  // but unlike create we do NOT return the plaintext here — a clone's key is revealed
  // on demand via Settings → Regenerate key, so an unused secret never transits the
  // wire (plan 002 decision).
  app.post("/:id/clone", sameOrigin, async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    const source = await deps.canvases.findById(id);
    if (!source || source.status === "deleted") return c.json({ error: "not_found" }, 404);

    // Non-owner clone eligibility runs through the SAME gallery visibility predicate as
    // browse (plan 002 U5), org-scoped to the caller: an org template is cloneable only by
    // a member of its org; a personal public_link template (org_id null) stays cloneable.
    // PLUS the team branch (plan 003 U4): a member of one of a `team` canvas's granted teams
    // may clone it — team canvases never reach the gallery, so this is their only clone path,
    // gated by the SAME live-org `teamMatch` re-join that the serve seam uses (KTD3).
    const orgIds = c.get("orgIds") ?? new Set<string>();
    const eligible =
      source.ownerId === user.id
        ? source.status === "active"
        : (await deps.canvases.findCloneableTemplate(id, Date.now(), {
            tenancyActive: !!deps.config.org.name,
            viewerOrgIds: orgIds,
          })) !== null ||
          (source.access === "team" &&
            source.status === "active" &&
            !!deps.teams &&
            (await deps.teams.teamMatch(id, user.id, orgIds)));
    if (!eligible) return c.json({ error: "not_found" }, 404);

    const { canvas } = await deps.clone.clone(source, user.id);
    deps.audit.recordAudit({
      action: "canvas_clone",
      actorId: user.id,
      targetId: canvas.id,
      meta: { from: source.id },
    });
    return c.json(await canvasView(canvas), 201);
  });

  /** Enrich a canvas list with each canvas's last-deploy summary in one batched
   *  version lookup (no N+1). Shared by the active list and the archived list.
   *  `recentSinceMs` is the trending-window floor for the per-row `recentViews`
   *  number — one batched `recentViewCounts` over the page (same window the
   *  `popular` sort ranks by), so the displayed count matches the sort order.
   *  `precomputedViews` lets the `popular` path hand back the counts it already
   *  ranked by, so that sort never aggregates `usage_events` twice (plan 004). */
  async function withLastDeploy(
    list: Canvas[],
    recentSinceMs: number,
    precomputedViews?: Map<string, number>,
  ) {
    const currentIds = list
      .map((cv) => cv.currentVersionId)
      .filter((id): id is string => id !== null);
    const byId = new Map((await deps.versions.findByIds(currentIds)).map((v) => [v.id, v]));
    // Globals are request-global (not per-canvas) — resolve once, reuse for the row.
    const globals = await resolveGlobals();
    // Batched lookups for the whole page (no N+1): preview hints + recent view counts.
    // The popular sort already computed the page's counts, so reuse them there.
    const [previews, recentViews] = await Promise.all([
      previewIds(list.map((cv) => cv.id)),
      precomputedViews ??
        deps.usage.recentViewCounts(
          list.map((cv) => cv.id),
          recentSinceMs,
        ),
    ]);
    return list.map((cv) => {
      const v = cv.currentVersionId ? byId.get(cv.currentVersionId) : undefined;
      return {
        ...ownerCanvasView(deps.config, cv, globals, previewVisible(cv, previews)),
        // Trending views over the recent window (0 when the canvas has none).
        recentViews: recentViews.get(cv.id) ?? 0,
        lastDeploy: v
          ? {
              version: v.number,
              createdAt: v.createdAt,
              fileCount: v.fileCount,
              totalBytes: v.totalBytes,
            }
          : null,
      };
    });
  }

  // List the caller's own canvases — active by default, or the archived set when
  // `scope=archived` (the Your-canvases Active/Archived toggle, replacing the old
  // standalone /archived view). Server-side filter/search/sort + offset pagination
  // (plan 005): a malformed query falls back to all-defaults so the list never 400s,
  // and every param ANDs onto the owner-scope base in the repo — it can only shrink
  // the caller's own set.
  app.get("/", async (c) => {
    // `c.req.query()` flattens repeated params; read `tag` via `queries("tag")` so
    // `?tag=a&tag=b` round-trips as an array (multi-tag any-match). Cap at 20: a canvas
    // carries at most 20 tags, so extra selections add cost, not matches.
    const tags = c.req.queries("tag")?.slice(0, CANVAS_MAX_TAGS);
    const parsed = ownerListQuerySchema.safeParse({
      ...c.req.query(),
      tag: tags && tags.length > 0 ? tags : undefined,
    });
    const data = parsed.success
      ? parsed.data
      : {
          q: undefined,
          tag: undefined,
          access: undefined,
          shared: false,
          protected: false,
          listed: false,
          template: false,
          undeployed: false,
          scope: "active" as const,
          sort: "updated" as const,
          limit: CANVASES_PAGE_SIZE,
          offset: 0,
        };
    const limit = Math.min(Math.max(data.limit, 1), CANVASES_MAX_LIMIT);
    const offset = Math.max(data.offset, 0);

    const userId = c.get("user").id;
    // One trending-window floor reused for BOTH the `popular` ranking and the per-row
    // `recentViews` number, so the order and the displayed counts can't disagree.
    const recentSinceMs = Date.now() - POPULAR_WINDOW_MS;
    // The filtered page and the (filter-independent) inventory summary have no data
    // dependency — run them concurrently rather than serially.
    const [{ items, total, recentViews }, summary] = await Promise.all([
      deps.canvases.listByOwnerFiltered({
        ownerId: userId,
        q: data.q,
        tag: data.tag,
        access: data.access,
        shared: data.shared,
        protected: data.protected,
        listed: data.listed,
        template: data.template,
        neverDeployed: data.undeployed,
        archived: data.scope === "archived",
        sort: data.sort,
        popularSinceMs: recentSinceMs,
        limit,
        offset,
      }),
      deps.canvases.ownerSummary(userId),
    ]);
    const canvases = await withLastDeploy(items, recentSinceMs, recentViews);
    return c.json({ canvases, total, limit, offset, summary });
  });

  // Slug availability for live UX (plan 004 U4). MUST be registered BEFORE `/:id` or
  // Hono captures it as `id="slug-available"`. No `sameOrigin` — it's a read GET, like
  // its siblings (that guard is for mutating routes). Authenticated via the gateway.
  // The body carries ONLY { available, reason? } — no canvas fields leak (§12.2). The
  // existence check is status-unaware so it agrees with the unconditional unique index.
  app.get("/slug-available", async (c) => {
    const raw = (c.req.query("slug") ?? "").trim();
    const check = validateSlug(raw);
    if (!check.ok) return c.json({ available: false, reason: check.reason });
    const taken = await deps.canvases.slugTaken(raw);
    return c.json(taken ? { available: false, reason: "taken" } : { available: true });
  });

  // Owner tag vocabulary for the Your-canvases TagFilter (plan 2026-06-19). Symmetric
  // to the gallery's `/api/gallery/facets`: returns the owner's distinct tags across
  // ALL their non-deleted canvases, so the filter offers the complete vocabulary
  // instead of just the tags on the loaded page. Static path segment, so registered
  // BEFORE `/:id` (Hono would otherwise capture it as `:id="tags"`). Read GET, no
  // sameOrigin (that guards mutations); authenticated via the gateway. Owner-scoped in
  // the repo — only the caller's own tags, never another owner's (§12).
  app.get("/tags", async (c) => {
    const tags = await deps.canvases.listOwnerTagFacets(c.get("user").id);
    return c.json({ tags });
  });

  // Owner-scoped slug → id resolution (rebrand U17). When the owner pastes a canvas's
  // cosmetic slug URL (`/canvases/<slug>`) the dashboard resolves it here, then
  // redirects to the canonical id route. Static path segment, so it's registered
  // before `/:id` (Hono captures it as `:id="by-slug"` otherwise). Returns ONLY the
  // opaque id, and ONLY when the caller owns that slug — a non-owned/unknown slug
  // 404s with no existence leak (§12.0 owner-scope, same posture as `/:id`).
  app.get("/by-slug/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!slug) return c.json({ error: "not_found" }, 404);
    const cv = await deps.canvases.findBySlug(slug);
    if (!cv || cv.status === "deleted" || cv.ownerId !== c.get("user").id) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ id: cv.id });
  });

  // "Shared with my teams" (plan 003 U5): the team canvases the caller can reach via a
  // team they belong to. This is the ONLY surface for strictly-team-scoped canvases —
  // they never appear in the org-wide gallery (locked decision). Static segment, so it
  // is registered before `/:id` (else Hono captures it as `:id="shared-with-teams"`).
  // The repo join re-uses the caller's LIVE server-resolved orgIds (KTD3 re-join), so a
  // user removed from the org sees nothing here. Excludes the caller's OWN canvases
  // (those live in Your-canvases) and anything not live (unpublished/archived/disabled
  // → unreachable anyway). Display-only projection — never leaks owner email / secrets.
  app.get("/shared-with-teams", async (c) => {
    const user = c.get("user");
    const orgIds = c.get("orgIds") ?? new Set<string>();
    if (!deps.teams) return c.json({ canvases: [] });
    const shared = await listSharedWithTeams(
      { teams: deps.teams, canvases: deps.canvases, users: deps.users },
      user.id,
      orgIds,
    );
    const previews = await previewIds(shared.map((s) => s.canvas.id));
    return c.json({
      canvases: shared.map(({ canvas: cv, owner }) => ({
        id: cv.id,
        slug: cv.slug,
        url: canvasUrl(deps.config, cv.slug),
        title: cv.title,
        description: cv.description,
        hasPreview: previewVisible(cv, previews),
        owner,
      })),
    });
  });

  app.get("/:id", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    return c.json(await canvasView(cv));
  });

  // Owner usage stats (D24): KV op count + file storage (M6) + AI tokens/cost and
  // realtime connect count (M9), derived from usage_events + files + ai_usage.
  // Owner-only (ownedCanvas), dashboard-session gated — NOT the runtime router.
  // Realtime is ephemeral, so "peak concurrent connections" isn't derivable; we
  // surface the connect count (rt_connect events) instead.
  app.get("/:id/usage", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    return c.json(await fetchCanvasUsage(deps, cv.id));
  });

  app.patch("/:id/settings", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    const body = settingsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    // The share/gallery preconditions + persisted-patch shaping live in the shared
    // resolver (also used by the MCP update_canvas tool), so the two can't diverge.
    const resolution = resolveSettingsUpdate(cv, body.data, {
      publicLinksEnabled: await (deps.publicLinksEnabled?.() ?? Promise.resolve(true)),
      canPublishPublic: c.get("user").canPublishPublic,
      publicEdgeCacheTtlSec: deps.config.serving.publicEdgeCacheTtlSec,
      now: Date.now(),
      tenancyActive: !!deps.config.org.name,
    });
    if (!resolution.ok) {
      return c.json({ code: resolution.code, message: resolution.message }, resolution.status);
    }
    const { patch, password, targetAccess, warning } = resolution;

    // Team grant flow (plan 003 U4/U5): resolve + persist the canvas→team grants BEFORE
    // the access write, so a forbidden grant never leaves a team canvas with zero teams (an
    // explicit deny to everyone). The shared resolver (also used by MCP update_canvas)
    // validates owner-team membership (KTD4), requires ≥1 team when sharing, lets an agent
    // change the grant set without re-sending `access`, and clears on a rung change away
    // from team. `teamGranted` drives the audit for a grant-only change (no rung change).
    let teamGranted = false;
    if (deps.teams) {
      const grant = await resolveTeamGrant(deps.teams, c.get("user").id, {
        canvasOrgId: cv.orgId,
        currentAccess: cv.access,
        targetAccess,
        teamIds: body.data.teamIds,
      });
      if (grant.kind === "error") {
        const status = grant.code === "TEAM_REQUIRED" ? 409 : 403;
        const message =
          grant.code === "TEAM_REQUIRED"
            ? "Pick at least one team to share with."
            : "You can only share with teams you belong to in this org.";
        return c.json({ code: grant.code, message }, status);
      }
      if (grant.kind === "write") {
        await deps.teams.setCanvasTeams(cv.id, grant.teamIds);
        teamGranted = true;
      } else if (grant.kind === "clear") {
        await deps.teams.setCanvasTeams(cv.id, []);
      }
    }

    let updated = cv;
    if (Object.keys(patch).length > 0) {
      updated = await deps.canvases.updateSettings(cv.id, patch);
    }
    // Leaving `custom` for auto/off through the settings API (or MCP update_canvas) must
    // drop the owner-uploaded renditions, exactly as DELETE /:id/preview does — otherwise
    // they orphan in storage and serve.ts would hand the stale custom image back under
    // `auto`. The dedicated DELETE endpoint owns the custom→auto UI path; this covers the
    // API/agent path that sets previewMode directly.
    if (
      cv.previewMode === "custom" &&
      (patch.previewMode === "auto" || patch.previewMode === "off")
    ) {
      await deletePreviewRenditions(deps.storage, cv.id);
    }
    if (password !== undefined) {
      const hash = password === null ? null : await hashPassword(password);
      updated = await deps.canvases.setPassword(cv.id, hash);
      deps.audit.recordAudit({
        action: "password_change",
        actorId: c.get("user").id,
        targetId: cv.id,
        meta: { cleared: password === null },
      });
    }
    // Audit a rung change, OR a grant-only change to the team set (no rung change) — the
    // latter would otherwise leave no trail when an owner re-picks the granted teams.
    if (targetAccess !== undefined || teamGranted) {
      deps.audit.recordAudit({
        action: "share_change",
        actorId: c.get("user").id,
        targetId: cv.id,
        meta: { access: targetAccess ?? cv.access, ...(teamGranted ? { teamsChanged: true } : {}) },
      });
    }
    // Revoke-drops-socket (D-RT-6): un-share / new-expiry drop sockets that lost
    // access; a newly-set password drops gated non-owners (no re-verified grant).
    if (deps.hub) {
      await deps.hub
        .revalidateCanvas(cv.id)
        .catch((err) =>
          c.get("log")?.warn({ err, canvasId: cv.id }, "hub: revalidateCanvas failed"),
        );
      if (typeof password === "string")
        await deps.hub
          .dropGatedNonOwners(cv.id)
          .catch((err) =>
            c.get("log")?.warn({ err, canvasId: cv.id }, "hub: dropGatedNonOwners failed"),
          );
    }
    const view = await canvasView(updated);
    return c.json(warning ? { ...view, warning } : view);
  });

  // --- Access allowlist (D4 `specific_people` rung, U4) -------------------------
  // One Add person model: existing users are granted now; new admissible emails are pending.

  /** List a canvas's allowlist entries with member display identity resolved. */
  app.get("/:id/allowlist", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const entries = await resolveAllowlistEntries(
      await deps.canvases.listAllowlist(cv.id),
      deps.users,
      deps.invitations ? await deps.invitations.listPendingForTarget("canvas", cv.id) : [],
    );
    return c.json({ entries });
  });

  // Normalize at the boundary (trim + lowercase) so allowlist/invite dedup on the
  // unique (canvas_id, email) index is case-insensitive and member matching is
  // consistent — "Alice@x.com" and "alice@x.com" are one principal.
  const allowlistAddSchema = z.object({
    email: z
      .string()
      .email()
      .transform((e) => e.trim().toLowerCase()),
  });

  function addPersonFailure(c: Context<AppEnv>, status: string) {
    if (status === "policy_blocked") {
      return c.json(
        { code: "NOT_PERMITTED", message: "That email can't be added from here." },
        403,
      );
    }
    if (status === "auth_admission_required") {
      return c.json(
        {
          code: "AUTH_ADMISSION_REQUIRED",
          message: "That email must be admitted by the configured identity provider first.",
        },
        403,
      );
    }
    if (status === "blocked") {
      return c.json({ code: "BLOCKED", message: "That account is blocked." }, 403);
    }
    if (status === "rate_limited") {
      return c.json({ code: "RATE_LIMITED", message: "Too many invites — try again later." }, 429);
    }
    return null;
  }

  async function addPerson(c: Context<AppEnv>, cv: Canvas, email: string, mode: "add" | "invite") {
    if (!deps.invites)
      return c.json({ code: "EMAIL_NOT_CONFIGURED", message: "Invites are unavailable." }, 503);
    const actor = c.get("user");
    const r = await deps.invites.resolveOrInvite(
      {
        kind: "canvas",
        canvasId: cv.id,
        canvasSlug: cv.slug,
        canvasTitle: cv.title,
        mode,
      },
      email,
      { id: actor.id, name: actor.name, email: actor.email, isAdmin: actor.isAdmin },
    );
    const failure = addPersonFailure(c, r.status);
    if (failure) return failure;
    deps.audit.recordAudit({
      action: "allowlist_add",
      actorId: actor.id,
      targetId: cv.id,
      meta: { kind: "add_person", mode, status: r.status },
    });
    return c.json({ ok: true, status: r.status });
  }

  /** Add person: existing user -> granted now; admissible new email -> pending. */
  app.post("/:id/allowlist", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    const body = allowlistAddSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    return addPerson(c, cv, body.data.email, "add");
  });

  /** Individual one-canvas access email (plan 003 U8): routes through the
   *  auth-delegated Add person primitive. An existing user is granted + emailed (per
   *  `notifyOnCanvasInvite`); a brand-new email becomes pending access that materializes
   *  on their first verified login (no app-owned credential), with the individual access
   *  email. KTD5-gated + rate-limited (a self-serve owner can't permit a new
   *  external email unless the toggle is on). */
  app.post("/:id/invite", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    const body = allowlistAddSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    return addPerson(c, cv, body.data.email, "invite");
  });

  /** Remove an allowlist entry; revoke a guest's invite + sessions, and drop any
   *  live sockets it no longer permits. */
  app.delete("/:id/allowlist/:entryId", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    const entryId = c.req.param("entryId");
    if (entryId.startsWith("pending:")) {
      const cancelled =
        (await deps.invitations?.cancelPendingForTarget(
          "canvas",
          cv.id,
          entryId.slice("pending:".length),
        )) ?? false;
      if (!cancelled) return c.json({ error: "not_found" }, 404);
      deps.audit.recordAudit({
        action: "allowlist_remove",
        actorId: c.get("user").id,
        targetId: cv.id,
        meta: { entryId, kind: "pending" },
      });
      await revalidate(c, cv.id);
      return c.json({ ok: true });
    }
    const entry = (await deps.canvases.listAllowlist(cv.id)).find((e) => e.id === entryId);
    if (entry?.principalKind === "guest" && entry.email && deps.guests) {
      await deps.guests.revokeInvite(cv.id, entry.email);
    }
    await deps.canvases.removeAllowlistEntry(cv.id, entryId);
    deps.audit.recordAudit({
      action: "allowlist_remove",
      actorId: c.get("user").id,
      targetId: cv.id,
      meta: { entryId, kind: entry?.principalKind ?? null },
    });
    await revalidate(c, cv.id);
    return c.json({ ok: true });
  });

  app.patch("/:id/capabilities", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    const body = capabilitiesSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const patch = body.data;
    if (Object.keys(patch).length === 0) return c.json(await canvasView(cv));
    const updated = await deps.canvases.updateCapabilities(cv.id, patch);
    deps.audit.recordAudit({
      action: "capabilities_update",
      actorId: c.get("user").id,
      targetId: cv.id,
      meta: { changed: Object.keys(patch) },
    });
    // Turning realtime (or the backend group) off must drop live sockets — the
    // heartbeat would too, but this makes it instant (D-RT-6).
    await revalidate(c, cv.id);
    return c.json(await canvasView(updated));
  });

  app.post("/:id/regenerate-slug", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    // Optional custom slug (plan 004): absent/empty → random (existing behavior).
    const body = z
      .object({ slug: z.string().max(63).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const resolved = await resolveCreateSlug(body.data.slug, (s) => deps.canvases.slugTaken(s));
    if ("error" in resolved) return c.json({ error: resolved.error }, 400);
    let updated: Canvas;
    try {
      updated = await deps.canvases.regenerateSlug(cv.id, resolved.slug, resolved.custom);
    } catch (err) {
      if (resolved.custom && isUniqueViolation(err, SLUG_UNIQUE)) {
        return c.json({ error: "slug_taken" }, 409);
      }
      throw err;
    }
    deps.audit.recordAudit({ action: "slug_regen", actorId: c.get("user").id, targetId: cv.id });
    // Old slug URLs are invalidated — drop all live sockets so clients reconnect
    // under the new slug (D-RT-6 / §12.0 #5).
    deps.hub?.dropCanvas(cv.id);
    return c.json(await canvasView(updated));
  });

  app.post("/:id/regenerate-key", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    const apiKey = generateApiKey();
    await deps.canvases.regenerateApiKey(cv.id, hashApiKey(apiKey));
    deps.audit.recordAudit({ action: "key_regen", actorId: c.get("user").id, targetId: cv.id });
    return c.json({ apiKey }); // shown once
  });

  // --- Custom preview (plan 004 follow-up) -------------------------------------
  // Upload an owner-chosen cover image. The raw image body is encoded into the same
  // og/card/thumb WebP renditions an auto-capture produces, then `previewMode=custom`
  // pins it so a publish never overwrites it. Body cap is the single-blob limit (25 MB,
  // matching the dashboard's own client cap) — not the whole-archive deploy limit — so a
  // non-browser caller can't feed an arbitrarily large bitmap into the sharp decode.
  app.put("/:id/preview", sameOrigin, blobBodyLimit, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) return c.json({ code: "EMPTY_IMAGE", message: "empty body" }, 400);
    let renditions: Awaited<ReturnType<typeof encodeRenditions>>;
    try {
      renditions = await encodeRenditions(body); // sharp reads png/jpeg/webp/… ; cover-crops
    } catch {
      return c.json({ code: "INVALID_IMAGE", message: "could not read that image" }, 400);
    }
    for (const rendition of SCREENSHOT_RENDITIONS) {
      await deps.storage.put(screenshotKey(cv.id, rendition), renditions[rendition], {
        contentType: "image/webp",
      });
    }
    const updated = await deps.canvases.updateSettings(cv.id, { previewMode: "custom" });
    deps.audit.recordAudit({
      action: "settings_update",
      actorId: c.get("user").id,
      targetId: cv.id,
      meta: { previewMode: "custom" },
    });
    return c.json(await canvasView(updated));
  });

  // Remove the custom preview → revert to `auto` (next publish re-captures) and delete
  // the stored renditions so nothing stale is served in the meantime. Guarded to
  // `custom` only: on a non-custom canvas this is a no-op, so it can never delete a
  // legitimately auto-captured screenshot (idempotent "ensure no custom cover").
  app.delete("/:id/preview", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    if (cv.previewMode !== "custom") return c.json(await canvasView(cv));
    await deletePreviewRenditions(deps.storage, cv.id);
    const updated = await deps.canvases.updateSettings(cv.id, { previewMode: "auto" });
    deps.audit.recordAudit({
      action: "settings_update",
      actorId: c.get("user").id,
      targetId: cv.id,
      meta: { previewMode: "auto" },
    });
    return c.json(await canvasView(updated));
  });

  app.delete("/:id", sameOrigin, async (c) => {
    // A canvas an admin has taken down cannot be deleted (§12.0 #5): deleting then
    // having an admin restore it would launder the takedown into an active canvas. It
    // must be `enable`d (admin route) first. This holds for every owner — there is no
    // admin shortcut, and an admin has no owner access to someone else's canvas anyway.
    // `mutableCanvas` enforces this with the shared `DISABLED` contract.
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    await deps.canvases.setStatus(cv.id, "deleted");
    deps.audit.recordAudit({ action: "canvas_delete", actorId: c.get("user").id, targetId: cv.id });
    // Deleted → everyone (incl. owner) loses access; drop their live sockets.
    await revalidate(c, cv.id);
    await revokeGuests(c, cv.id);
    return c.json({ ok: true });
  });

  // Archive (owner-initiated, reversible) — takes the canvas offline (its public
  // URL 404s) and moves it to the Archive view. The guarded repo transition
  // returns false only for an already-deleted row, which ownedCanvas already 404s.
  app.post("/:id/archive", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    if (!(await deps.canvases.archive(cv.id))) return c.json({ error: "not_found" }, 404);
    deps.audit.recordAudit({
      action: "canvas_archive",
      actorId: c.get("user").id,
      targetId: cv.id,
    });
    // Archived → offline for everyone; drop live sockets (D-RT-6) and revoke guest
    // grants so re-publishing later doesn't silently resurrect them.
    await revalidate(c, cv.id);
    await revokeGuests(c, cv.id);
    return c.json(await canvasView({ ...cv, status: "archived", ...CLEARED_PUBLICATION_FIELDS }));
  });

  // Unarchive — restore an archived canvas to active. A 409 on an invalid
  // transition (the canvas isn't archived) rather than silently flipping status.
  app.post("/:id/unarchive", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    if (!(await deps.canvases.unarchive(cv.id))) {
      return c.json({ code: "NOT_ARCHIVED", message: "canvas is not archived" }, 409);
    }
    deps.audit.recordAudit({
      action: "canvas_unarchive",
      actorId: c.get("user").id,
      targetId: cv.id,
    });
    return c.json(await canvasView({ ...cv, status: "active" }));
  });

  // Unpublish — take a published canvas back to Draft (its public URL 404s) while
  // keeping it in the owner's active list and fully editable. Clears the gallery
  // listing (a Draft can't be in the gallery). A 409 when the canvas isn't
  // currently published (Draft/archived/disabled) rather than silently no-opping.
  app.post("/:id/unpublish", sameOrigin, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    if (!(await deps.canvases.unpublish(cv.id))) {
      // Distinct code from the gallery's NOT_PUBLISHED precondition; the message
      // is self-describing so the dashboard surfaces it directly (no HINTS entry).
      return c.json({ code: "CANNOT_UNPUBLISH", message: "This canvas isn't published." }, 409);
    }
    deps.audit.recordAudit({
      action: "canvas_unpublish",
      actorId: c.get("user").id,
      targetId: cv.id,
    });
    // Offline for everyone now → drop live sockets (D-RT-6) and revoke guest grants
    // so re-publishing later doesn't silently resurrect them.
    await revalidate(c, cv.id);
    await revokeGuests(c, cv.id);
    return c.json(
      await canvasView({ ...cv, currentVersionId: null, ...CLEARED_PUBLICATION_FIELDS }),
    );
  });

  // Deploy history (§6.1.13). Session-authed sibling of the Bearer `/v1` versions
  // endpoint — owner-only, no existence leak. GET, so no same-origin guard.
  app.get("/:id/versions", async (c) => {
    const cv = await ownedCanvas(c);
    if (!cv) return c.json({ error: "not_found" }, 404);
    const versions = await deps.versions.listByCanvas(cv.id);
    return c.json({
      versions: versions.map((v) => ({
        number: v.number,
        source: v.source,
        status: v.status,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        current: v.id === cv.currentVersionId,
        // What this version serves at the canvas root (entry file / why not).
        entry: rootEntry((v.manifest ?? {}) as Manifest),
      })),
    });
  });

  // One-click rollback (§6.1.12). Mutation → same-origin guard. `findReadyByNumber`
  // is canvas-scoped, so a version number from another canvas cannot resolve.
  app.post("/:id/rollback", sameOrigin, async (c) => {
    // A disabled canvas rejects with the shared DISABLED contract; an archived one keeps
    // the NOT_ACTIVE "unarchive first" message (mutableCanvas only catches disabled).
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    if (cv.status !== "active") return c.json(NOT_ACTIVE, 409);
    const parsed = z
      .object({ version: z.number().int().positive() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    const version = parsed.data.version;
    const target = await deps.versions.findReadyByNumber(cv.id, version);
    if (!target) {
      return c.json({ code: "INVALID_PATH", message: `no ready version ${version}` }, 404);
    }
    // Atomic guarded swap — false means a concurrent prune deleted the target
    // between selection and the swap; surface a clean retry rather than a
    // dangling pointer that would 404 the live canvas.
    if (!(await deps.canvases.setCurrentVersionIfReady(cv.id, target.id))) {
      return c.json(
        {
          code: "VERSION_UNAVAILABLE",
          message: "that version was just removed; refresh and try another",
        },
        409,
      );
    }
    deps.audit.recordAudit({
      action: "rollback",
      actorId: c.get("user").id,
      targetId: cv.id,
      meta: { version },
    });
    // Reflect the swap from known-good data (target.id) rather than re-reading —
    // avoids returning a stale snapshot if a refetch transiently fails.
    return c.json({
      ...(await canvasView({ ...cv, currentVersionId: target.id })),
      version,
    });
  });

  // --- Deploy entry points (UI calls these; the engine + result shape is U18/U19) ---

  // Paste-HTML quick create: create a canvas, then deploy a single index.html.
  app.post("/paste", sameOrigin, deployBodyLimit, async (c) => {
    const body = z
      .object({
        html: z.string().min(1),
        title: z.string().max(200).optional(),
        slug: z.string().max(63).optional(),
        backendEnabled: z.boolean().optional(),
        orgId: z.string().nullable().optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    const user = c.get("user");
    // Home tenant (plan 002 U6), validated against the caller's membership — same rule as
    // the management create, so the paste create path can't bypass it.
    const home = resolveHomeOrg(body.data.orgId, c.get("orgIds") ?? new Set<string>());
    if ("error" in home) return c.json({ error: home.error }, 403);
    const resolved = await resolveCreateSlug(body.data.slug, (s) => deps.canvases.slugTaken(s));
    if ("error" in resolved) return c.json({ error: resolved.error }, 400);
    const apiKey = generateApiKey();
    // A taken custom slug throws inside create() — BEFORE any row exists and before the
    // deploy try-block below — so map it to 409 here; there is no orphan to clean up
    // (the deploy-failure soft-delete further down is a separate concern). (plan 004 KTD8)
    let cv: Canvas;
    try {
      cv = await deps.canvases.create({
        ownerId: user.id,
        slug: resolved.slug,
        slugCustom: resolved.custom,
        apiKeyHash: hashApiKey(apiKey),
        title: body.data.title,
        orgId: home.orgId,
        backendEnabled: body.data.backendEnabled,
      });
    } catch (err) {
      if (resolved.custom && isUniqueViolation(err, SLUG_UNIQUE)) {
        return c.json({ error: "slug_taken" }, 409);
      }
      throw err;
    }
    deps.audit.recordAudit({ action: "canvas_create", actorId: user.id, targetId: cv.id });
    // Deploy directly (typed result) rather than re-parsing a Response body. If
    // the deploy fails, soft-delete the just-created canvas so no orphan + its
    // once-shown key are left behind.
    try {
      const deploy = await deps.engine.deploy(cv, "paste", fromPasteHtml(body.data.html), user.id);
      deps.audit.recordAudit({
        action: "deploy",
        actorId: user.id,
        targetId: cv.id,
        meta: { source: "paste", version: deploy.version },
      });
      return c.json({ ...(await canvasView(cv)), apiKey, deploy }, 201);
    } catch (err) {
      await deps.canvases.setStatus(cv.id, "deleted").catch(() => {});
      if (err instanceof DeployError) {
        return c.json({ code: err.code, message: err.message, path: err.path }, 400);
      }
      throw err;
    }
  });

  app.post("/:id/deploy/zip", sameOrigin, deployBodyLimit, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    if (cv.status !== "active") return c.json(NOT_ACTIVE, 409);
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.byteLength === 0) return c.json({ code: "EMPTY_DEPLOY", message: "empty body" }, 400);
    return deployResponse(c, deps.engine, deps.audit, cv, "zip", fromZip(buf), c.get("user").id);
  });

  app.post("/:id/deploy/folder", sameOrigin, deployBodyLimit, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    if (cv.status !== "active") return c.json(NOT_ACTIVE, 409);
    // Each multipart file field's KEY is the file's canvas-relative path.
    const form = await c.req.parseBody({ all: true });
    const entries: DeployEntry[] = [];
    for (const [path, value] of Object.entries(form)) {
      const files = Array.isArray(value) ? value : [value];
      for (const f of files) {
        if (f instanceof File) {
          entries.push({ path, bytes: new Uint8Array(await f.arrayBuffer()) });
        }
      }
    }
    return deployResponse(c, deps.engine, deps.audit, cv, "folder", entries, c.get("user").id);
  });

  // Paste a new index.html as the next version of an EXISTING canvas (the
  // same-origin sibling of /paste, which is create-only). Mirrors zip/folder.
  app.post("/:id/deploy/paste", sameOrigin, deployBodyLimit, async (c) => {
    const cv = await mutableCanvas(c);
    if (cv instanceof Response) return cv;
    if (cv.status !== "active") return c.json(NOT_ACTIVE, 409);
    const body = z
      .object({ html: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid_body" }, 400);
    return deployResponse(
      c,
      deps.engine,
      deps.audit,
      cv,
      "paste",
      fromPasteHtml(body.data.html),
      c.get("user").id,
    );
  });

  return app;
}

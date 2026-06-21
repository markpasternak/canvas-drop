import { Buffer } from "node:buffer";
import { CANVAS_MAX_TAG_LENGTH, CANVAS_MAX_TAGS, type Config } from "@canvas-drop/shared";
import type { Canvas, Manifest } from "@canvas-drop/shared/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit/audit-log.js";
import type { GuestService } from "../auth/guest.js";
import { resolveAllowlistEntries } from "../canvas/allowlist-view.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import type { CloneService } from "../canvas/clone-service.js";
import { inviteGuestToCanvas } from "../canvas/guest-invite.js";
import { liveManifest } from "../canvas/manifest.js";
import { isTextContentType } from "../canvas/mime.js";
import { DISABLED_CODE, disabledMessage } from "../canvas/owner-guard.js";
import { hashPassword } from "../canvas/password.js";
import { resolveSettingsUpdate } from "../canvas/settings-update.js";
import { resolveCreateSlug } from "../canvas/slug.js";
import { blobKey, SCREENSHOT_RENDITIONS, screenshotKey } from "../canvas/storage-keys.js";
import { canvasUrl, deployEndpoints } from "../canvas/url.js";
import { fetchCanvasUsage } from "../canvas/usage-stats.js";
import type { AiUsageRepository } from "../db/repositories/ai-usage.js";
import { type CanvasesRepository, POPULAR_WINDOW_MS } from "../db/repositories/canvases.js";
import type { FilesRepository } from "../db/repositories/files.js";
import type { OrgMembersRepository } from "../db/repositories/org-members.js";
import type { OrgsRepository } from "../db/repositories/orgs.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsageEventsRepository } from "../db/repositories/usage-events.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { isUniqueViolation, SLUG_UNIQUE } from "../db/unique-violation.js";
import type { DeployEngine } from "../deploy/engine.js";
import { LIMITS } from "../deploy/errors.js";
import { fromFilesArray, fromZip } from "../deploy/ingest.js";
import type { DraftService } from "../draft/service.js";
import type { Mailer } from "../email/mailer.js";
import type { Logger } from "../log/logger.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { encodeRenditions } from "../screenshots/capture.js";
import { deletePreviewRenditions } from "../screenshots/custom-preview.js";
import {
  type PreviewHintDeps,
  previewVisible,
  resolvePreviewIds,
} from "../screenshots/preview-ids.js";
import type { StorageDriver } from "../storage/driver.js";
import type { TeamActor, TeamError, TeamsService } from "../teams/service.js";
import { listSharedWithTeams, resolveTeamGrant, resolveVisibleTeams } from "../teams/sharing.js";
import { resolveHomeOrg } from "../tenancy/home-org.js";
import type { UploadService } from "../upload/service.js";
import { registerDraftTools } from "./draft-tools.js";
import { canvasView, fail, failDeploy, ok, type ToolResult } from "./tool-kit.js";

/** Preview hint (plan 004) — agent-native parity with the dashboard. Optional via
 *  PreviewHintDeps; omitted → `hasPreview` false / no `previewUrl`, like pipeline-off. */
export interface McpToolDeps extends PreviewHintDeps {
  config: Config;
  users: UsersRepository;
  /** Tenancy org store (plan 002 U7): `findById` for whoami names; `findByDomain` for the
   *  route's membership resolver that derives the caller's orgIds. */
  orgs: Pick<OrgsRepository, "findById" | "findByDomain">;
  /** Explicit org-membership store (plan 003 U2) — the MCP membership resolver
   *  materializes a row so a pure-MCP user still appears in the org roster. */
  orgMembers: Pick<OrgMembersRepository, "upsertDomainMember">;
  /** Teams store + service (plan 003 U6) — agent-native parity for the team tools and
   *  the `team` canvas grant. The tools wrap the SAME service the management routes use. */
  teams: TeamsRepository;
  teamsService: TeamsService;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  engine: DeployEngine;
  upload: UploadService;
  /** Blob store — read-only here, backs the `get_canvas_file` verification tool. */
  storage: StorageDriver;
  audit: AuditLog;
  /** Structured logger — used to surface non-client faults (e.g. an image-encode
   *  failure in `set_canvas_preview`) that are otherwise hidden behind a user-facing fail. */
  log: Logger;
  hub?: RealtimeHub;
  /** Guest magic-link service (oidc/dev only; absent in proxy mode, where guest
   *  invites are refused — the IAP owns that boundary). Backs the guest-access tools
   *  and the guest-grant revocation on archive/unpublish/delete. */
  guests?: GuestService;
  /** Mailer for guest invites (absent → invites refused with EMAIL_NOT_CONFIGURED). */
  mailer?: Mailer;
  /** Clone-as-template service — backs `clone_canvas`. */
  clone: CloneService;
  /** Draft/editor service — backs the draft tools (get/read/write/publish/discard). */
  drafts: DraftService;
  /** Usage stats sources — back `get_canvas_usage`. */
  usage: UsageEventsRepository;
  files: FilesRepository;
  aiUsage: AiUsageRepository;
}

/** Largest blob `get_canvas_file` will inline into the model context (256 KiB).
 *  Bigger files report metadata only — verify those by hash, or fetch over HTTP. */
const READBACK_MAX_BYTES = 256 * 1024;

/** The acting MCP caller — `userId` comes only from the verified access token (U3).
 *  `orgIds` is the caller's SERVER-resolved org membership (plan 002 U7), resolved by the
 *  MCP route from the user — never client-asserted; `tenancyActive` mirrors config. */
export interface McpCaller {
  userId: string;
  orgIds: Set<string>;
  tenancyActive: boolean;
}

/** The owner-and-mutable gate: resolves to the owned canvas, or a `ToolResult` the tool
 *  must return as-is (404-shape not-found, or the shared DISABLED refusal). Passed to
 *  `registerDraftTools` so the draft EDIT tools share the management surface's gate. */
export type RequireMutable = (id: string) => Promise<{ canvas: Canvas } | { error: ToolResult }>;

/**
 * The MCP tool surface (U5). A fresh server is built per request, bound to the
 * caller resolved from the verified OAuth token. Every tool wraps the SAME service
 * layer the HTTP API uses — no parallel logic — and every canvas-scoped tool runs
 * the owner check (`requireOwned`) so a caller can only act on canvases it owns;
 * a non-owned id is indistinguishable from a missing one (no existence leak, §12.0).
 */
export function buildMcpServer(deps: McpToolDeps, caller: McpCaller): McpServer {
  const server = new McpServer({ name: "canvas-drop", version: "1" });

  /** Load the canvas only if the caller owns it, else null. */
  async function requireOwned(id: string) {
    const cv = await deps.canvases.findById(id);
    if (!cv || cv.status === "deleted" || cv.ownerId !== caller.userId) return null;
    return cv;
  }

  /** Owner-and-mutable gate (parity with management.ts `mutableCanvas`): a disabled
   *  (admin-taken-down) canvas is read-only to its owner, so every owner MUTATION tool
   *  rejects with the shared `DISABLED` contract while the read tools keep using
   *  `requireOwned`. Returns the canvas, or a `ToolResult` the tool returns as-is —
   *  `fail("canvas not found")` when not owned/missing (no existence leak, §12.0), or
   *  `fail("DISABLED: …")` (mirroring the HTTP 409 `{ code: "DISABLED", message }`). */
  const requireMutable: RequireMutable = async (id) => {
    const cv = await requireOwned(id);
    if (!cv) return { error: fail("canvas not found") };
    if (cv.status === "disabled") {
      return { error: fail(`${DISABLED_CODE}: ${disabledMessage(cv)}`) };
    }
    return { canvas: cv };
  };

  /** Captured-preview hint for the owned canvases in hand — see {@link resolvePreviewIds}
   *  (shared gate + degrade with the management and gallery surfaces). */
  const previewIds = (canvasIds: string[]) => resolvePreviewIds(deps, canvasIds);

  /** The team-management actor for THIS caller (plan 003 U6). `isAdmin` is fixed FALSE on
   *  the per-account MCP surface: cross-owner admin team actions are the dedicated admin
   *  routes only (agent-native parity rule's exception), so over MCP "manage" means the
   *  team CREATOR only. `orgIds` is the caller's LIVE server-resolved membership. */
  const teamActor: TeamActor = { id: caller.userId, isAdmin: false, orgIds: caller.orgIds };

  /** Map a {@link TeamError} from the shared service to a stable `CODE: message` fail —
   *  the same posture as the HTTP team routes (a non-owned/unknown team reads as not found). */
  const TEAM_FAIL: Record<TeamError, string> = {
    NOT_A_MEMBER: "NOT_A_MEMBER: you are not a member of that org",
    TEAM_NOT_FOUND: "TEAM_NOT_FOUND: team not found",
    FORBIDDEN: "FORBIDDEN: only the team's creator can do that over MCP",
    TARGET_NOT_FOUND: "TARGET_NOT_FOUND: no account with that email has signed in yet",
    TARGET_NOT_MEMBER: "TARGET_NOT_MEMBER: that person is not a member of this org",
  };

  server.registerTool(
    "whoami",
    { description: "Return the identity of the connected canvas-drop account.", inputSchema: {} },
    async () => {
      const user = await deps.users.findById(caller.userId);
      if (!user) return fail("account not found");
      // Tenancy (plan 002 U7): the caller's orgs + guest flag, mirroring /api/me. Resolved
      // from the caller's SERVER-derived orgIds — never anything the client asserted.
      const orgRows = (
        await Promise.all([...caller.orgIds].map((id) => deps.orgs.findById(id)))
      ).filter((o): o is NonNullable<typeof o> => o !== null);
      // The caller's teams (plan 003 U6) — the ones they belong to, for discoverability
      // (the share-with-a-team grant + the "shared with my teams" read reference these).
      const teamRows = await deps.teams.listForUser(caller.userId);
      return ok({
        id: user.id,
        email: user.email,
        name: user.name,
        orgs: orgRows.map((o) => ({ id: o.id, name: o.name })),
        teams: teamRows.map((t) => ({ id: t.id, name: t.name, slug: t.slug, orgId: t.orgId })),
        isGuest: caller.tenancyActive && caller.orgIds.size === 0,
      });
    },
  );

  server.registerTool(
    "list_canvases",
    {
      description:
        "List the canvases you own. Default order is most-recently-updated; pass " +
        'sort="popular" to rank by trending views over the last 30 days. Each item ' +
        "carries `recentViews` (trending count) plus lifetime `viewCount` and `lastViewedAt`.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Optional forgiving text filter over title, description, tags, and slug " +
              "(case/accent/whitespace-insensitive; multiple words are AND-ed).",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Filter to canvases carrying any of these tags."),
        sort: z
          .enum(["updated", "created", "title", "popular"])
          .optional()
          .describe('Sort order (default "updated"). "popular" = most trending views (30d).'),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 50)."),
      },
    },
    async ({ query, tags, sort, limit }) => {
      const recentSinceMs = Date.now() - POPULAR_WINDOW_MS;
      const {
        items,
        total,
        recentViews: rankedViews,
      } = await deps.canvases.listByOwnerFiltered({
        ownerId: caller.userId,
        q: query,
        tag: tags,
        sort,
        popularSinceMs: recentSinceMs,
        limit: limit ?? 50,
        offset: 0,
      });
      // The popular sort already aggregated the page's counts — reuse them rather than
      // hitting usage_events twice (plan 004); other sorts aggregate the page here.
      const [previews, recentViews] = await Promise.all([
        previewIds(items.map((cv) => cv.id)),
        rankedViews ??
          deps.usage.recentViewCounts(
            items.map((cv) => cv.id),
            recentSinceMs,
          ),
      ]);
      return ok({
        total,
        canvases: items.map((cv) => ({
          ...canvasView(deps.config, cv, previewVisible(cv, previews)),
          recentViews: recentViews.get(cv.id) ?? 0,
        })),
      });
    },
  );

  // Agent-native parity note (plan 002 U7 decision): `list_canvases` is OWNER-scoped (your
  // own canvases) and is unaffected by tenancy. The dashboard's new org-GALLERY browse
  // (whole_org canvases of your org that you don't own) is intentionally NOT exposed over
  // MCP in P1 — org-gallery-browse-over-MCP is an explicit Phase 2 deferral. An agent can
  // still `clone_canvas` an org template by id (org-scoped above); only discovery-by-browse
  // is deferred. This is the recorded choice, not an accidental "inherits for free" gap.
  server.registerTool(
    "create_canvas",
    {
      description:
        "Create a new canvas you own. Returns its id, URL, a one-time deploy API key, AND a " +
        "`deploy` block with the EXACT, ready-to-run curl endpoints for this canvas (apiBase, " +
        "zipUpload, the staged upload URLs, readback, and a copy-paste `curl` command with the " +
        "key already filled in). If you can run shell commands, deploy with that curl — you do " +
        "NOT need to know or probe for the API host; it's in the block. The " +
        "canvas starts empty (no live version) and private; its URL only serves content after a " +
        "deploy, and only to viewers allowed by its access rung (default: sign-in required).",
      inputSchema: {
        title: z.string().optional(),
        description: z.string().optional(),
        backendEnabled: z.boolean().optional().describe("Enable the backend capability."),
        slug: z
          .string()
          .max(63)
          .optional()
          .describe("Custom URL slug; omit for a readable-random one. Must be unused and valid."),
        orgId: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Home tenant: an org id you belong to (see whoami.orgs), or null for a personal " +
              "canvas. Omit to default to your org when you have exactly one. Drives whether a " +
              "later `whole_org` access rung shares it with that org.",
          ),
      },
    },
    async ({ title, description, backendEnabled, slug: requestedSlug, orgId }) => {
      // Home tenant (plan 002 U7): validated against the caller's server-resolved membership,
      // the SAME resolveHomeOrg the dashboard/management create uses — never trusts the client.
      const home = resolveHomeOrg(orgId, caller.orgIds);
      if ("error" in home) return fail("ORG_FORBIDDEN: you are not a member of that org");
      const resolved = await resolveCreateSlug(requestedSlug, (s) => deps.canvases.slugTaken(s));
      if ("error" in resolved) return fail("INVALID_SLUG: not a valid slug");
      const apiKey = generateApiKey();
      let cv: Awaited<ReturnType<typeof deps.canvases.create>>;
      try {
        cv = await deps.canvases.create({
          ownerId: caller.userId,
          slug: resolved.slug,
          slugCustom: resolved.custom,
          apiKeyHash: hashApiKey(apiKey),
          title,
          description,
          orgId: home.orgId,
          backendEnabled,
        });
      } catch (err) {
        if (resolved.custom && isUniqueViolation(err, SLUG_UNIQUE)) {
          return fail("SLUG_TAKEN: that slug is already in use");
        }
        throw err;
      }
      deps.audit.recordAudit({ action: "canvas_create", actorId: caller.userId, targetId: cv.id });
      // The key is returned once and never again — same contract as the dashboard.
      // Hand back ready-to-run curl endpoints (with the real key embedded) so an
      // agent that prefers curl never has to probe for the API host.
      return ok({
        ...canvasView(deps.config, cv),
        apiKey,
        deploy: deployEndpoints(deps.config, cv.id, apiKey),
      });
    },
  );

  server.registerTool(
    "get_canvas",
    {
      description:
        "Get the current state of a canvas you own. Also returns a `deploy` block with the exact " +
        "curl endpoints for this canvas (apiBase, zipUpload, staged URLs, readback, and a " +
        "copy-paste `curl` with a $CANVAS_KEY placeholder — substitute the key from create_canvas). " +
        "Use this to get the runnable deploy command for an existing canvas without probing.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
      const hasPreview = previewVisible(cv, await previewIds([cv.id]));
      // Echo the team grants for a team-scoped canvas (parity with the dashboard share view).
      const teamIds =
        cv.access === "team" ? await deps.teams.listTeamIdsForCanvas(cv.id) : undefined;
      // Endpoints carry a `$CANVAS_KEY` placeholder here — the key is only handed out
      // once, at create. The agent substitutes the key it saved from create_canvas.
      return ok({
        ...canvasView(deps.config, cv, hasPreview, teamIds),
        deploy: deployEndpoints(deps.config, cv.id),
      });
    },
  );

  server.registerTool(
    "list_versions",
    {
      description: "List the published versions of a canvas you own.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
      const versions = await deps.versions.listByCanvas(cv.id);
      return ok({
        versions: versions.map((v) => ({
          number: v.number,
          source: v.source,
          status: v.status,
          createdAt: v.createdAt,
          fileCount: v.fileCount,
          totalBytes: v.totalBytes,
          current: v.id === cv.currentVersionId,
        })),
      });
    },
  );

  server.registerTool(
    "deploy_canvas",
    {
      description:
        "Deploy a canvas you own in ONE call. NOTE: if you can run shell commands, PREFER curl " +
        "over the keyed HTTP Deploy API instead of this tool — request that permission if you " +
        "don't have it. The exact, ready-to-run curl command + endpoints are in the `deploy` " +
        "block that create_canvas (with the key filled in) and get_canvas return — use those " +
        "verbatim, do NOT probe for the API host. curl streams file bytes straight from disk to " +
        "the server so they never enter your context (far cheaper, no size ceiling); every MCP " +
        "deploy tool inlines the bytes into the model. Use this MCP tool only when you genuinely " +
        "cannot run commands, and then only for a FIRST publish of a small canvas. " +
        "This PUBLISHES IMMEDIATELY: the uploaded files become the new live version at once " +
        "(there is no draft step — every deploy goes live and is kept as an immutable version). " +
        "The live URL is ACCESS-CONTROLLED (org sign-in / share rung), so do NOT verify by " +
        "fetching it — an unauthenticated GET returns a login page, not your files. Verify " +
        "through this server instead: the returned {version, fileCount} or get_canvas / " +
        "list_versions / get_canvas_file. " +
        "Provide EITHER a base64 ZIP (zipBase64) OR a files array (text as UTF-8, binary as " +
        "base64) — not both. The entire payload travels in this call, so prefer " +
        "begin_deploy/add_files/finalize_deploy for ANY re-deploy of a canvas that already has " +
        "content, or when it has many/large/binary files: that flow reports exactly which files " +
        "changed so you resend only those (far fewer tokens) and can chunk big uploads.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        zipBase64: z
          .string()
          .optional()
          .describe("A base64-encoded ZIP archive of the canvas files."),
        files: z
          .array(
            z.object({
              path: z.string(),
              content: z.string(),
              encoding: z.enum(["utf8", "base64"]).optional(),
            }),
          )
          .optional()
          .describe("Inline files: text as utf8 (default), binary as base64."),
      },
    },
    async ({ id, zipBase64, files }) => {
      // Mirror publish_draft + the HTTP deploy routes: a deploy on an archived/disabled
      // canvas would silently pre-position content that goes live the moment it's
      // restored, defeating the admin freeze. A disabled canvas rejects with the shared
      // DISABLED contract; an archived one keeps the NOT_ACTIVE "unarchive first" message.
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      if (cv.status !== "active") {
        return fail(
          "NOT_ACTIVE: unarchive this canvas before deploying or changing its live version",
        );
      }
      // Exactly one payload form — an ambiguous both / empty neither is a client error.
      if (zipBase64 != null && files != null) {
        return fail("INVALID_REQUEST: provide either zipBase64 or files, not both");
      }
      if (zipBase64 == null && (files == null || files.length === 0)) {
        return fail("INVALID_REQUEST: provide zipBase64 or a non-empty files array");
      }
      try {
        let result: Awaited<ReturnType<typeof deps.engine.deploy>>;
        if (files != null) {
          result = await deps.engine.deploy(cv, "upload", fromFilesArray(files), caller.userId);
        } else {
          // Buffer.from(..,"base64") never throws — it drops invalid chars — so a bad
          // string just yields fewer/zero bytes; the empty guard and the downstream
          // DeployError (caught below) cover malformed input.
          const buffer = Buffer.from(zipBase64 as string, "base64");
          if (buffer.byteLength === 0) return fail("empty deploy");
          result = await deps.engine.deploy(cv, "api", fromZip(buffer), caller.userId);
        }
        deps.audit.recordAudit({
          action: "deploy",
          actorId: caller.userId,
          targetId: cv.id,
          meta: { source: "mcp", version: result.version },
        });
        return ok(result);
      } catch (e) {
        // A DeployError carries a stable .code → surface it; anything else is a real
        // bug/infra fault and must propagate (not be flattened into a vague user error).
        return failDeploy(e);
      }
    },
  );

  server.registerTool(
    "begin_deploy",
    {
      description:
        "Open a staged deploy for a canvas you own. PREFER THIS over deploy_canvas whenever the " +
        "canvas already has content (any re-deploy) or has many/large/binary files. Give the " +
        "file manifest (path, sha256 hash, size); returns an uploadId and missingHashes — the " +
        "files NOT already stored — so you resend only what changed (a re-deploy of mostly-" +
        "unchanged files sends almost nothing). Then add_files for those hashes, then " +
        "finalize_deploy.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        manifest: z
          .array(
            z.object({
              path: z.string(),
              hash: z.string().describe("sha256 hex of the file's bytes."),
              size: z.number().int().nonnegative(),
            }),
          )
          .describe("The full set of files this deploy will publish."),
      },
    },
    async ({ id, manifest }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      if (cv.status !== "active") {
        return fail(
          "NOT_ACTIVE: unarchive this canvas before deploying or changing its live version",
        );
      }
      try {
        return ok(await deps.upload.begin(cv, caller.userId, manifest));
      } catch (e) {
        return failDeploy(e);
      }
    },
  );

  server.registerTool(
    "add_files",
    {
      description:
        "Stage files into an open upload (from begin_deploy). Text as utf8 (default), binary as " +
        "base64. Call repeatedly to chunk a large set; only send the hashes begin_deploy reported " +
        "missing. NOTE: this inlines file bytes into the model — if you can run shell commands, " +
        "PREFER curl: PUT each missing blob's raw bytes to the keyed HTTP Deploy API so the bytes " +
        "never enter your context. The exact staged URLs (begin/stageBlob/finalize) are in the " +
        "`deploy` block from create_canvas/get_canvas — no need to probe for the host. Request " +
        "command permission if needed rather than streaming large/binary files through here.",
      inputSchema: {
        id: z.string().describe("The canvas id (must own it)."),
        uploadId: z.string().describe("The uploadId from begin_deploy."),
        files: z
          .array(
            z.object({
              path: z.string(),
              content: z.string(),
              encoding: z.enum(["utf8", "base64"]).optional(),
            }),
          )
          .describe("Files to stage this call."),
      },
    },
    async ({ id, uploadId, files }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      try {
        await deps.upload.stageFiles(uploadId, caller.userId, cv.id, files);
        return ok({ staged: files.length });
      } catch (e) {
        return failDeploy(e);
      }
    },
  );

  server.registerTool(
    "finalize_deploy",
    {
      description:
        "Publish a new live version from a staged upload (from begin_deploy). PUBLISHES " +
        "IMMEDIATELY (the version goes live at once; no draft step). Single-use; fails if any " +
        "manifest blob is still missing. Don't verify by fetching the live URL — it's access-" +
        "controlled and returns a login page to an unauthenticated GET; confirm with the " +
        "returned {version, fileCount} or get_canvas / list_versions / get_canvas_file instead.",
      inputSchema: {
        id: z.string().describe("The canvas id (must own it)."),
        uploadId: z.string().describe("The uploadId from begin_deploy."),
      },
    },
    async ({ id, uploadId }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      if (cv.status !== "active") {
        return fail(
          "NOT_ACTIVE: unarchive this canvas before deploying or changing its live version",
        );
      }
      try {
        const result = await deps.upload.finalize(uploadId, caller.userId, cv.id);
        deps.audit.recordAudit({
          action: "deploy",
          actorId: caller.userId,
          targetId: cv.id,
          meta: { source: "mcp-upload", version: result.version },
        });
        return ok(result);
      } catch (e) {
        return failDeploy(e);
      }
    },
  );

  server.registerTool(
    "get_canvas_file",
    {
      description:
        "Read back what is LIVE on a canvas you own — the way to verify a deploy. The live URL " +
        "is access-controlled (an unauthenticated GET returns a login page, not your files), so " +
        "confirm a deploy through here, never by fetching the URL. Omit `path` to list the live " +
        "version's files (path, size, mime, hash); pass `path` (e.g. 'index.html') to get that " +
        "file's content — text as UTF-8, binary as base64. Files over 256 KiB return metadata " +
        "(size + hash) only; verify those by comparing the hash to what you deployed.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        path: z
          .string()
          .optional()
          .describe("File path within the live version (e.g. 'index.html'). Omit to list files."),
      },
    },
    async ({ id, path }) => {
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
      const live = await liveManifest(deps.versions, cv.currentVersionId);
      if (!live) return fail("this canvas has no live version yet");
      const { number: version, manifest } = live;
      const paths = Object.keys(manifest).sort();

      // No path → the live file listing: a cheap "what's actually live" check that
      // never pulls blob bytes into context.
      if (path == null) {
        return ok({
          version,
          fileCount: paths.length,
          files: paths.map((p) => {
            const e = manifest[p] as Manifest[string];
            return { path: p, size: e.size, mime: e.mime, hash: e.hash };
          }),
        });
      }

      const entry = manifest[path];
      if (!entry) return fail(`no file at "${path}" in the live version`);
      // Don't inline a large blob — return metadata so the agent can verify by hash
      // (or fetch the raw bytes over HTTP via the readback endpoint, which has no cap).
      if (entry.size > READBACK_MAX_BYTES) {
        return ok({
          version,
          path,
          size: entry.size,
          mime: entry.mime,
          hash: entry.hash,
          truncated: true,
          note: `file is ${entry.size} bytes (> ${READBACK_MAX_BYTES}); content omitted — verify by hash, or GET ${deployEndpoints(deps.config, cv.id).apiBase}/files?path=${encodeURIComponent(path)}`,
        });
      }
      const bytes = await deps.storage.get(blobKey(cv.id, entry.hash));
      if (!bytes) return fail("file blob missing from storage");
      const text = isTextContentType(entry.mime);
      return ok({
        version,
        path,
        size: entry.size,
        mime: entry.mime,
        hash: entry.hash,
        encoding: text ? "utf8" : "base64",
        content: Buffer.from(bytes).toString(text ? "utf8" : "base64"),
      });
    },
  );

  server.registerTool(
    "rollback_canvas",
    {
      description: "Point a canvas you own back at a previously published version number.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        version: z.number().int().describe("The version number to make current."),
      },
    },
    async ({ id, version }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      if (cv.status !== "active") {
        return fail(
          "NOT_ACTIVE: unarchive this canvas before deploying or changing its live version",
        );
      }
      const target = await deps.versions.findReadyByNumber(cv.id, version);
      if (!target) return fail(`no ready version ${version}`);
      if (!(await deps.canvases.setCurrentVersionIfReady(cv.id, target.id))) {
        return fail("that version was just removed; retry");
      }
      deps.audit.recordAudit({
        action: "rollback",
        actorId: caller.userId,
        targetId: cv.id,
        meta: { version },
      });
      if (deps.hub)
        await deps.hub
          .revalidateCanvas(cv.id)
          .catch((err) => deps.log.warn({ err, canvasId: cv.id }, "hub: revalidateCanvas failed"));
      return ok({ ...canvasView(deps.config, { ...cv, currentVersionId: target.id }), version });
    },
  );

  server.registerTool(
    "unpublish_canvas",
    {
      description: "Take a published canvas you own back to draft (clears the live version).",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      if (!(await deps.canvases.unpublish(cv.id)))
        return fail("CANNOT_UNPUBLISH: this canvas isn't published");
      deps.audit.recordAudit({
        action: "canvas_unpublish",
        actorId: caller.userId,
        targetId: cv.id,
      });
      // Offline for everyone now → drop live sockets and revoke guest grants so
      // re-publishing later doesn't silently resurrect them (mirrors the route).
      if (deps.hub)
        await deps.hub
          .revalidateCanvas(cv.id)
          .catch((err) => deps.log.warn({ err, canvasId: cv.id }, "hub: revalidateCanvas failed"));
      if (deps.guests)
        await deps.guests
          .revokeAllForCanvas(cv.id)
          .catch((err) =>
            deps.log.error({ err, canvasId: cv.id }, "guests: revokeAllForCanvas failed"),
          );
      return ok({
        url: canvasUrl(deps.config, cv.slug),
        publicationState: "draft",
        currentVersionId: null,
      });
    },
  );

  server.registerTool(
    "set_capabilities",
    {
      description:
        "Toggle a canvas's backend capabilities (same as the dashboard Backend tab). `backendEnabled` " +
        "is the master switch; kv/files/ai/realtime are individual features (effective only when " +
        "backend is on). Omitted fields are unchanged. Turning a capability (or the master) off drops " +
        "live sockets that lost access.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        backendEnabled: z.boolean().optional(),
        kv: z.boolean().optional(),
        files: z.boolean().optional(),
        ai: z.boolean().optional(),
        realtime: z.boolean().optional(),
      },
    },
    async ({ id, ...patch }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (Object.keys(fields).length === 0) return ok(canvasView(deps.config, cv));
      const updated = await deps.canvases.updateCapabilities(cv.id, fields);
      deps.audit.recordAudit({
        action: "capabilities_update",
        actorId: caller.userId,
        targetId: cv.id,
        meta: { changed: Object.keys(fields) },
      });
      if (deps.hub)
        await deps.hub
          .revalidateCanvas(cv.id)
          .catch((err) => deps.log.warn({ err, canvasId: cv.id }, "hub: revalidateCanvas failed"));
      return ok(canvasView(deps.config, updated));
    },
  );

  server.registerTool(
    "set_canvas_slug",
    {
      description:
        "Change a canvas's URL slug (same as Settings → Change slug). Pass `slug` for a custom one, " +
        "or omit it for a fresh readable-random slug. The OLD URL stops working immediately. Returns " +
        "the updated canvas (with its new url + deploy endpoints).",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        slug: z.string().max(63).optional().describe("New custom slug; omit for a random one."),
      },
    },
    async ({ id, slug }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      const resolved = await resolveCreateSlug(slug, (s) => deps.canvases.slugTaken(s));
      if ("error" in resolved) return fail("INVALID_SLUG: not a valid slug");
      let updated: typeof cv;
      try {
        updated = await deps.canvases.regenerateSlug(cv.id, resolved.slug, resolved.custom);
      } catch (err) {
        if (resolved.custom && isUniqueViolation(err, SLUG_UNIQUE)) {
          return fail("SLUG_TAKEN: that slug is already in use");
        }
        throw err;
      }
      deps.audit.recordAudit({ action: "slug_regen", actorId: caller.userId, targetId: cv.id });
      deps.hub?.dropCanvas(cv.id);
      return ok({
        ...canvasView(deps.config, updated),
        deploy: deployEndpoints(deps.config, cv.id),
      });
    },
  );

  server.registerTool(
    "regenerate_deploy_key",
    {
      description:
        "Mint a NEW deploy API key for a canvas you own and invalidate the old one (same as Settings → " +
        "Regenerate key). Returns the new `cd_…` key ONCE, plus a refreshed `deploy` block with the " +
        "key embedded in the curl command. Use this if the key leaked or you lost it.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      const apiKey = generateApiKey();
      await deps.canvases.regenerateApiKey(cv.id, hashApiKey(apiKey));
      deps.audit.recordAudit({ action: "key_regen", actorId: caller.userId, targetId: cv.id });
      return ok({ apiKey, deploy: deployEndpoints(deps.config, cv.id, apiKey) });
    },
  );

  server.registerTool(
    "archive_canvas",
    {
      description:
        "Archive a canvas you own (reversible) — takes its public URL offline and moves it to the " +
        "Archive view. Revokes guest grants. Use unarchive_canvas to restore it.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      if (!(await deps.canvases.archive(cv.id))) return fail("canvas not found");
      deps.audit.recordAudit({ action: "canvas_archive", actorId: caller.userId, targetId: cv.id });
      if (deps.hub)
        await deps.hub
          .revalidateCanvas(cv.id)
          .catch((err) => deps.log.warn({ err, canvasId: cv.id }, "hub: revalidateCanvas failed"));
      if (deps.guests)
        await deps.guests
          .revokeAllForCanvas(cv.id)
          .catch((err) =>
            deps.log.error({ err, canvasId: cv.id }, "guests: revokeAllForCanvas failed"),
          );
      return ok(canvasView(deps.config, { ...cv, status: "archived", currentVersionId: null }));
    },
  );

  server.registerTool(
    "unarchive_canvas",
    {
      description: "Restore an archived canvas you own back to active. Fails if it isn't archived.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      if (!(await deps.canvases.unarchive(cv.id)))
        return fail("NOT_ARCHIVED: canvas is not archived");
      deps.audit.recordAudit({
        action: "canvas_unarchive",
        actorId: caller.userId,
        targetId: cv.id,
      });
      return ok(canvasView(deps.config, { ...cv, status: "active" }));
    },
  );

  server.registerTool(
    "delete_canvas",
    {
      description:
        "Soft-delete a canvas you own (same as the dashboard Delete) — it loses its URL for everyone " +
        "and is purged after the retention window. A canvas an admin has DISABLED cannot be deleted " +
        "(it must be re-enabled first). This is not reversible from the MCP.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      // requireMutable enforces the "a DISABLED canvas can't be deleted" rule with the
      // shared DISABLED contract (deleting then admin-restoring would launder the takedown).
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      await deps.canvases.setStatus(cv.id, "deleted");
      deps.audit.recordAudit({ action: "canvas_delete", actorId: caller.userId, targetId: cv.id });
      if (deps.hub)
        await deps.hub
          .revalidateCanvas(cv.id)
          .catch((err) => deps.log.warn({ err, canvasId: cv.id }, "hub: revalidateCanvas failed"));
      if (deps.guests)
        await deps.guests
          .revokeAllForCanvas(cv.id)
          .catch((err) =>
            deps.log.error({ err, canvasId: cv.id }, "guests: revokeAllForCanvas failed"),
          );
      return ok({ ok: true });
    },
  );

  // ---- Settings (U7) ---------------------------------------------------------

  server.registerTool(
    "update_canvas",
    {
      description:
        "Update a canvas you own (mirrors the dashboard Settings + Share tabs). All fields optional; " +
        "omitted = unchanged. Set the access rung, a password (or null to clear), a share expiry, " +
        "rename/redescribe, the SPA fallback, and gallery listing/metadata — the server enforces the " +
        "preconditions (sharing/listing need a published canvas; public_link needs an admin grant; a " +
        "password un-lists from the gallery). The allowlist for `specific_people` is managed with " +
        "grant_access / revoke_access. To share with one or more teams, set access='team' AND pass " +
        "`teamIds` (the teams you belong to — see whoami.teams / list_teams); you can only grant teams " +
        "you're a member of, in the canvas's org. Switching off the team rung clears the grants. When " +
        "restricting a previously-public canvas, the response may include a `warning` string (a " +
        "plain-language CDN edge-cache staleness notice) — surface it to the user.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        title: z.string().max(200).optional(),
        description: z
          .string()
          .max(2000)
          .nullable()
          .optional()
          .describe(
            "The canvas's description — one field shown in the canvas overview, the gallery, and " +
              "grid cards (shown publicly when the canvas is listed). null clears it.",
          ),
        access: z
          .enum(["private", "specific_people", "team", "whole_org", "public_link"])
          .optional(),
        teamIds: z
          .array(z.string().min(1))
          .max(50)
          .optional()
          .describe(
            "Teams to grant when access='team' (the teams you belong to in this canvas's org). " +
              "Required (≥1) when setting access='team'; ignored for other rungs.",
          ),
        password: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe("Set a password gate, or null to clear it."),
        sharedExpiresAt: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("Unix ms when the share expires, or null for no expiry."),
        spaFallback: z.boolean().optional(),
        previewMode: z
          .enum(["auto", "off"])
          .optional()
          .describe(
            "Preview policy: 'auto' screenshots on publish; 'off' disables the screenshot preview " +
              "(the preview URL returns 404 and the dashboard falls back to a procedurally generated " +
              "cover). Upload a custom image with set_canvas_preview.",
          ),
        guestAiEnabled: z.boolean().optional(),
        guestAiCap: z.number().min(0).optional(),
        galleryListed: z.boolean().optional(),
        galleryTemplatable: z.boolean().optional(),
        tags: z.array(z.string().max(CANVAS_MAX_TAG_LENGTH)).max(CANVAS_MAX_TAGS).optional(),
      },
    },
    async ({ id, ...input }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      const user = await deps.users.findById(caller.userId);
      const resolution = resolveSettingsUpdate(cv, input, {
        canPublishPublic: user?.canPublishPublic ?? false,
        publicEdgeCacheTtlSec: deps.config.serving.publicEdgeCacheTtlSec,
        now: Date.now(),
        tenancyActive: !!deps.config.org.name,
      });
      if (!resolution.ok) return fail(`${resolution.code}: ${resolution.message}`);
      const { patch, password, targetAccess, warning } = resolution;

      // Team grant flow (plan 003 U6) — the SAME shared resolver the management PATCH route
      // uses (agent-native parity), run BEFORE the access write so a forbidden grant never
      // leaves a team canvas with zero teams (a deny to everyone). Validates owner-team
      // membership (KTD4), requires ≥1 team when sharing, lets an agent change the grant set
      // without re-sending `access`, and clears on a rung change away from team.
      let teamGranted = false;
      {
        const grant = await resolveTeamGrant(deps.teams, caller.userId, {
          canvasOrgId: cv.orgId,
          currentAccess: cv.access,
          targetAccess,
          teamIds: input.teamIds,
        });
        if (grant.kind === "error") {
          return fail(
            grant.code === "TEAM_REQUIRED"
              ? "TEAM_REQUIRED: pick at least one team to share with"
              : "TEAM_FORBIDDEN: you can only share with teams you belong to in this org",
          );
        }
        if (grant.kind === "write") {
          await deps.teams.setCanvasTeams(cv.id, grant.teamIds);
          teamGranted = true;
        } else if (grant.kind === "clear") {
          await deps.teams.setCanvasTeams(cv.id, []);
        }
      }

      let updated = cv;
      if (Object.keys(patch).length > 0) updated = await deps.canvases.updateSettings(cv.id, patch);
      // Leaving `custom` for auto/off drops the owner-uploaded renditions (mirrors the
      // dashboard's DELETE /:id/preview), else they orphan and serve.ts would hand the
      // stale custom image back under `auto`. Agent-native parity with the HTTP path.
      if (
        cv.previewMode === "custom" &&
        (patch.previewMode === "auto" || patch.previewMode === "off")
      ) {
        await deletePreviewRenditions(deps.storage, cv.id);
      }
      if (password !== undefined) {
        updated = await deps.canvases.setPassword(
          cv.id,
          password === null ? null : await hashPassword(password),
        );
        deps.audit.recordAudit({
          action: "password_change",
          actorId: caller.userId,
          targetId: cv.id,
          meta: { cleared: password === null },
        });
      }
      // Audit a rung change OR a grant-only change to the team set (parity with the route).
      if (targetAccess !== undefined || teamGranted) {
        deps.audit.recordAudit({
          action: "share_change",
          actorId: caller.userId,
          targetId: cv.id,
          meta: {
            access: targetAccess ?? cv.access,
            ...(teamGranted ? { teamsChanged: true } : {}),
          },
        });
      }
      if (deps.hub) {
        await deps.hub.revalidateCanvas(cv.id).catch(() => {});
        if (typeof password === "string") await deps.hub.dropGatedNonOwners(cv.id).catch(() => {});
      }
      // Echo the resolved team grants when the canvas is team-scoped (read-your-writes).
      const teamIds =
        updated.access === "team" ? await deps.teams.listTeamIdsForCanvas(updated.id) : undefined;
      const view = canvasView(deps.config, updated, false, teamIds);
      return ok(warning ? { ...view, warning } : view);
    },
  );

  server.registerTool(
    "set_canvas_preview",
    {
      description:
        "Set or clear a canvas's custom preview cover (same as the dashboard preview upload). With " +
        "`image` (base64), it becomes the cover and `previewMode` is pinned to 'custom' so a publish " +
        "never overwrites it. Omit `image` to clear it — reverts to 'auto' (next publish re-captures). " +
        "Use update_canvas previewMode for the auto/off toggle.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        image: z
          .string()
          // A base64 string is ~4/3 the decoded size; cap it generously above the
          // per-file byte limit so the post-decode check is the precise gate, but a
          // grossly oversized payload is rejected before it's even decoded.
          .max(40 * 1024 * 1024)
          .optional()
          .describe("Base64-encoded image (png/jpeg/webp). Omit to clear the custom preview."),
      },
    },
    async ({ id, image }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      if (image === undefined) {
        // Clear is custom-only — never delete a legitimately auto-captured screenshot.
        if (cv.previewMode !== "custom") return ok(canvasView(deps.config, cv));
        await deletePreviewRenditions(deps.storage, cv.id);
        const updated = await deps.canvases.updateSettings(cv.id, { previewMode: "auto" });
        deps.audit.recordAudit({
          action: "settings_update",
          actorId: caller.userId,
          targetId: cv.id,
          meta: { previewMode: "auto" },
        });
        return ok(canvasView(deps.config, updated));
      }
      const bytes = new Uint8Array(Buffer.from(image, "base64"));
      if (bytes.byteLength === 0) return fail("INVALID_IMAGE: empty image");
      // Cap the decoded bytes BEFORE handing them to sharp — sharp bounds the decoded
      // pixel count, not the compressed input size, so a large valid encode would
      // otherwise allocate freely. Mirrors the HTTP PUT /:id/preview body limit.
      if (bytes.byteLength > LIMITS.maxFileBytes) {
        return fail("IMAGE_TOO_LARGE: image exceeds the per-file limit");
      }
      let renditions: Awaited<ReturnType<typeof encodeRenditions>>;
      try {
        renditions = await encodeRenditions(bytes);
      } catch (err) {
        // A codec crash / OOM / unexpected format is invisible without this — the
        // user-facing fail stays generic, but operators get a server-side trace.
        deps.log.warn({ err, canvasId: cv.id }, "set_canvas_preview encodeRenditions failed");
        return fail("INVALID_IMAGE: could not read that image");
      }
      for (const r of SCREENSHOT_RENDITIONS) {
        await deps.storage.put(screenshotKey(cv.id, r), renditions[r], {
          contentType: "image/webp",
        });
      }
      const updated = await deps.canvases.updateSettings(cv.id, { previewMode: "custom" });
      deps.audit.recordAudit({
        action: "settings_update",
        actorId: caller.userId,
        targetId: cv.id,
        meta: { previewMode: "custom" },
      });
      return ok(canvasView(deps.config, updated));
    },
  );

  // ---- Sharing & access (U4) -------------------------------------------------

  server.registerTool(
    "list_access",
    {
      description:
        "List who can access a canvas you own beyond the rung default — the named allowlist " +
        "(org members) and email-invited guests (same as the Share tab's people list). Each entry " +
        "has an `id` (use it with revoke_access), `kind` ('member'|'guest'), `email`, and `name`.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
      const entries = await resolveAllowlistEntries(
        await deps.canvases.listAllowlist(cv.id),
        deps.users,
      );
      return ok({ entries });
    },
  );

  server.registerTool(
    "grant_access",
    {
      description:
        "Grant a person access to a canvas you own by email (mirrors the Share tab's add-person). " +
        "If the email is an org member, they're added to the allowlist directly; otherwise an " +
        "email guest invite is sent (oidc/dev mode + configured email only — else fails " +
        "GUESTS_UNAVAILABLE / EMAIL_NOT_CONFIGURED). Note: the allowlist only takes effect on the " +
        "`specific_people` access rung — set that with update_canvas.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        email: z.string().email().describe("The person's email."),
      },
    },
    async ({ id, email: rawEmail }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      const email = rawEmail.trim().toLowerCase();
      const user = await deps.users.findByEmail(email);
      if (user) {
        await deps.canvases.addAllowlistEntry({
          canvasId: cv.id,
          principalKind: "member",
          userId: user.id,
        });
        deps.audit.recordAudit({
          action: "allowlist_add",
          actorId: caller.userId,
          targetId: cv.id,
          meta: { kind: "member", userId: user.id },
        });
        return ok({ ok: true, kind: "member" });
      }
      const inviter = await deps.users.findById(caller.userId);
      const r = await inviteGuestToCanvas(deps, {
        canvas: cv,
        inviterName: inviter?.name ?? "A teammate",
        actorId: caller.userId,
        email,
      });
      return r.ok ? ok({ ok: true, kind: "guest" }) : fail(`${r.code}: ${r.message}`);
    },
  );

  server.registerTool(
    "resend_guest_invite",
    {
      description:
        "Re-send a pending guest invite (fresh magic link). Pass the allowlist entry `id` from " +
        "list_access; only valid for a 'guest' entry.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        entryId: z.string().describe("The allowlist entry id (from list_access)."),
      },
    },
    async ({ id, entryId }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      const entry = (await deps.canvases.listAllowlist(cv.id)).find((e) => e.id === entryId);
      if (entry?.principalKind !== "guest" || !entry.email) return fail("guest invite not found");
      const inviter = await deps.users.findById(caller.userId);
      const r = await inviteGuestToCanvas(deps, {
        canvas: cv,
        inviterName: inviter?.name ?? "A teammate",
        actorId: caller.userId,
        email: entry.email,
      });
      return r.ok ? ok({ ok: true }) : fail(`${r.code}: ${r.message}`);
    },
  );

  server.registerTool(
    "revoke_access",
    {
      description:
        "Remove an allowlist entry from a canvas you own (member or guest). Pass the entry `id` " +
        "from list_access. Revokes a guest's invite + sessions and drops any live sockets it no " +
        "longer permits.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        entryId: z.string().describe("The allowlist entry id (from list_access)."),
      },
    },
    async ({ id, entryId }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      const entry = (await deps.canvases.listAllowlist(cv.id)).find((e) => e.id === entryId);
      if (entry?.principalKind === "guest" && entry.email && deps.guests) {
        await deps.guests.revokeInvite(cv.id, entry.email);
      }
      await deps.canvases.removeAllowlistEntry(cv.id, entryId);
      deps.audit.recordAudit({
        action: "allowlist_remove",
        actorId: caller.userId,
        targetId: cv.id,
        meta: { entryId, kind: entry?.principalKind ?? null },
      });
      if (deps.hub)
        await deps.hub
          .revalidateCanvas(cv.id)
          .catch((err) => deps.log.warn({ err, canvasId: cv.id }, "hub: revalidateCanvas failed"));
      return ok({ ok: true });
    },
  );

  // ---- Clone + usage (U5) ----------------------------------------------------

  server.registerTool(
    "clone_canvas",
    {
      description:
        "Clone a canvas into a NEW canvas you own, seeded from the source (mirrors gallery/Settings " +
        "Clone). You may clone any ACTIVE canvas you own, or a gallery-listed + templatable canvas " +
        "someone else shared. The clone starts as an unpublished draft with a fresh slug + key, " +
        "backend off. Returns the new canvas. A non-eligible/unknown source reads as not found.",
      inputSchema: { id: z.string().describe("The source canvas id.") },
    },
    async ({ id }) => {
      const source = await deps.canvases.findById(id);
      if (!source || source.status === "deleted") return fail("canvas not found");
      // Non-owner clone eligibility runs through the SAME org-scoped gallery predicate as
      // the dashboard (plan 002 U7): an org template is cloneable only by a member of its
      // org; a personal public_link template stays cloneable. Scoped to the caller's
      // server-resolved orgIds.
      const eligible =
        source.ownerId === caller.userId
          ? source.status === "active"
          : (await deps.canvases.findCloneableTemplate(id, Date.now(), {
              tenancyActive: caller.tenancyActive,
              viewerOrgIds: caller.orgIds,
            })) !== null ||
            // Team branch (plan 003): a member of one of a `team` canvas's granted teams may
            // clone it — same live-org `teamMatch` re-join the serve seam uses (KTD3).
            (source.access === "team" &&
              source.status === "active" &&
              (await deps.teams.teamMatch(id, caller.userId, caller.orgIds)));
      if (!eligible) return fail("canvas not found");
      const { canvas } = await deps.clone.clone(source, caller.userId);
      deps.audit.recordAudit({
        action: "canvas_clone",
        actorId: caller.userId,
        targetId: canvas.id,
        meta: { from: source.id },
      });
      return ok(canvasView(deps.config, canvas));
    },
  );

  server.registerTool(
    "get_canvas_usage",
    {
      description:
        "Usage stats for a canvas you own (same as the dashboard usage panel): view stats + a " +
        "30-day sparkline, and — for backend-on canvases — KV/file/AI/realtime op counts, file " +
        "storage, and AI tokens/cost.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
      return ok(await fetchCanvasUsage(deps, cv.id));
    },
  );

  // ---- Teams (plan 003 U6) ---------------------------------------------------
  // Self-serve team management + the "shared with my teams" read, wrapping the SAME
  // teamsService + teams repo the HTTP routes use (agent-native parity; identical
  // denials + audit events). Admin cross-owner team actions are NOT here — they live
  // on the dedicated admin routes (the parity rule's admin exception).

  server.registerTool(
    "create_team",
    {
      description:
        "Create a team in an org you belong to (see whoami.orgs). You become its first member " +
        "and its manager (rename/delete). Returns the new team.",
      inputSchema: {
        orgId: z.string().describe("An org id you belong to (whoami.orgs)."),
        name: z.string().trim().min(1).max(80).describe("The team's display name."),
      },
    },
    async ({ orgId, name }) => {
      const r = await deps.teamsService.create(teamActor, { orgId, name });
      if (!r.ok) return fail(TEAM_FAIL[r.error]);
      const { team } = r;
      return ok({ id: team.id, orgId: team.orgId, name: team.name, slug: team.slug });
    },
  );

  server.registerTool(
    "list_teams",
    {
      description:
        "List the teams in your org(s). Each carries `mine` (you're a member) and `canManage` " +
        "(you created it — so you can rename/delete it over MCP).",
      inputSchema: {},
    },
    async () => {
      // Shared resolver, isAdmin=false on the MCP surface (admin cross-owner team actions
      // live on the admin routes, not here) — so canManage == created-by-you.
      const teams = await resolveVisibleTeams(deps.teams, caller.userId, caller.orgIds, false);
      return ok({ teams });
    },
  );

  server.registerTool(
    "rename_team",
    {
      description:
        "Rename a team you created. A team you don't manage reads as not found/forbidden.",
      inputSchema: {
        id: z.string().describe("The team id."),
        name: z.string().trim().min(1).max(80).describe("The new name."),
      },
    },
    async ({ id, name }) => {
      const r = await deps.teamsService.rename(teamActor, id, name);
      if (!r.ok) return fail(TEAM_FAIL[r.error]);
      return ok({ id: r.team.id, name: r.team.name });
    },
  );

  server.registerTool(
    "delete_team",
    {
      description:
        "Delete a team you created. Removes its memberships and unshares every canvas shared with " +
        "it (the canvases are untouched). A team you don't manage reads as not found/forbidden.",
      inputSchema: { id: z.string().describe("The team id.") },
    },
    async ({ id }) => {
      const r = await deps.teamsService.remove(teamActor, id);
      if (!r.ok) return fail(TEAM_FAIL[r.error]);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "add_team_member",
    {
      description:
        "Add a colleague to a team you belong to, by email. They must be a member of the team's " +
        "org and have signed in at least once. Self-serve: any member can invite.",
      inputSchema: {
        id: z.string().describe("The team id."),
        email: z.string().trim().email().describe("The colleague's email."),
      },
    },
    async ({ id, email }) => {
      const r = await deps.teamsService.addMemberByEmail(teamActor, id, email);
      if (!r.ok) return fail(TEAM_FAIL[r.error]);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "remove_team_member",
    {
      description:
        "Remove a member from a team you belong to (pass your own user id to leave). Use " +
        "list_team_members for the user ids.",
      inputSchema: {
        id: z.string().describe("The team id."),
        userId: z.string().describe("The member's user id (your own id to leave)."),
      },
    },
    async ({ id, userId }) => {
      const r = await deps.teamsService.removeMember(teamActor, id, userId);
      if (!r.ok) return fail(TEAM_FAIL[r.error]);
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "list_team_members",
    {
      description:
        "List the members of a team in your org. A team outside your org(s) reads as not found.",
      inputSchema: { id: z.string().describe("The team id.") },
    },
    async ({ id }) => {
      const team = await deps.teams.findById(id);
      if (!team || !caller.orgIds.has(team.orgId)) return fail("team not found");
      const rows = await deps.teams.getMembers(team.id);
      const users = await deps.users.findByIds(rows.map((m) => m.userId));
      const byId = new Map(users.map((u) => [u.id, u]));
      return ok({
        members: rows.map((m) => {
          const u = byId.get(m.userId);
          return { userId: m.userId, email: u?.email ?? null, name: u?.name ?? null };
        }),
      });
    },
  );

  server.registerTool(
    "list_shared_with_teams",
    {
      description:
        "List canvases shared with one of your teams (the 'shared with my teams' view). These are " +
        "strictly team-scoped — they never appear in the org gallery. Excludes your own canvases " +
        "and anything not live. Display-only (you don't own these); open via the returned url.",
      inputSchema: {},
    },
    async () => {
      // Shared read (same as the HTTP /shared-with-teams route), so the projection can't
      // drift between surfaces. Include the same hasPreview + owner.avatarUrl the HTTP route
      // and the other MCP canvas projections (get_canvas/list_canvases) carry.
      const shared = await listSharedWithTeams(deps, caller.userId, caller.orgIds);
      const previews = await previewIds(shared.map((s) => s.canvas.id));
      return ok({
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
    },
  );

  // Draft / editor-loop tools (get/read/write/delete/rename/publish/restore) — split
  // into their own module to keep this registry under the file-size bar.
  registerDraftTools(server, deps, caller, requireOwned, requireMutable);

  return server;
}

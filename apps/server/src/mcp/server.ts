import { Buffer } from "node:buffer";
import type { Config } from "@canvas-drop/shared";
import { type CanvasStatus, type Manifest, publicationState } from "@canvas-drop/shared/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit/audit-log.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import { liveManifest } from "../canvas/manifest.js";
import { isTextContentType } from "../canvas/mime.js";
import { generateUniqueSlug } from "../canvas/slug.js";
import { blobKey } from "../canvas/storage-keys.js";
import { canvasUrl, deployEndpoints } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { DeployEngine } from "../deploy/engine.js";
import { DeployError } from "../deploy/errors.js";
import { fromFilesArray, fromZip } from "../deploy/ingest.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { type PreviewHintDeps, resolvePreviewIds } from "../screenshots/preview-ids.js";
import { PREVIEW_ASSET_PATH } from "../screenshots/serve.js";
import type { StorageDriver } from "../storage/driver.js";
import type { UploadService } from "../upload/service.js";

/** Preview hint (plan 004) — agent-native parity with the dashboard. Optional via
 *  PreviewHintDeps; omitted → `hasPreview` false / no `previewUrl`, like pipeline-off. */
export interface McpToolDeps extends PreviewHintDeps {
  config: Config;
  users: UsersRepository;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  engine: DeployEngine;
  upload: UploadService;
  /** Blob store — read-only here, backs the `get_canvas_file` verification tool. */
  storage: StorageDriver;
  audit: AuditLog;
  hub?: RealtimeHub;
}

/** Largest blob `get_canvas_file` will inline into the model context (256 KiB).
 *  Bigger files report metadata only — verify those by hash, or fetch over HTTP. */
const READBACK_MAX_BYTES = 256 * 1024;

/** The acting MCP caller — `userId` comes only from the verified access token (U3). */
export interface McpCaller {
  userId: string;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function canvasView(
  config: Config,
  cv: {
    id: string;
    slug: string;
    title: string;
    status: string;
    currentVersionId: string | null;
  },
  // A captured screenshot preview exists (plan 004). When true, `previewUrl` points at
  // the access-gated cover (`card` rendition) so an agent can surface it the same way
  // the dashboard does. Defaults false → no preview (pipeline off / not yet captured).
  hasPreview = false,
) {
  const url = canvasUrl(config, cv.slug);
  return {
    id: cv.id,
    slug: cv.slug,
    url,
    title: cv.title,
    status: cv.status,
    publicationState: publicationState(cv.status as CanvasStatus, cv.currentVersionId !== null),
    currentVersionId: cv.currentVersionId,
    hasPreview,
    ...(hasPreview
      ? { previewUrl: `${url.replace(/\/$/, "")}/${PREVIEW_ASSET_PATH}?rendition=card` }
      : {}),
  };
}

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

  /** Captured-preview hint for the owned canvases in hand — see {@link resolvePreviewIds}
   *  (shared gate + degrade with the management and gallery surfaces). */
  const previewIds = (canvasIds: string[]) => resolvePreviewIds(deps, canvasIds);

  server.registerTool(
    "whoami",
    { description: "Return the identity of the connected canvas-drop account.", inputSchema: {} },
    async () => {
      const user = await deps.users.findById(caller.userId);
      if (!user) return fail("account not found");
      return ok({ id: user.id, email: user.email, name: user.name });
    },
  );

  server.registerTool(
    "list_canvases",
    {
      description: "List the canvases you own (most-recently-updated first).",
      inputSchema: {
        query: z.string().optional().describe("Optional text filter on title/slug."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 50)."),
      },
    },
    async ({ query, limit }) => {
      const { items, total } = await deps.canvases.listByOwnerFiltered({
        ownerId: caller.userId,
        q: query,
        limit: limit ?? 50,
        offset: 0,
      });
      const previews = await previewIds(items.map((cv) => cv.id));
      return ok({
        total,
        canvases: items.map((cv) => canvasView(deps.config, cv, previews.has(cv.id))),
      });
    },
  );

  server.registerTool(
    "create_canvas",
    {
      description:
        "Create a new canvas you own. Returns its id, URL, and a one-time deploy API key. The " +
        "canvas starts empty (no live version) and private; its URL only serves content after a " +
        "deploy, and only to viewers allowed by its access rung (default: sign-in required).",
      inputSchema: {
        title: z.string().optional(),
        description: z.string().optional(),
        backendEnabled: z.boolean().optional().describe("Enable the backend capability."),
      },
    },
    async ({ title, description, backendEnabled }) => {
      const slug = await generateUniqueSlug(
        async (s) => (await deps.canvases.findBySlug(s)) !== null,
      );
      const apiKey = generateApiKey();
      const cv = await deps.canvases.create({
        ownerId: caller.userId,
        slug,
        apiKeyHash: hashApiKey(apiKey),
        title,
        description,
        backendEnabled,
      });
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
      description: "Get the current state of a canvas you own.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
      const hasPreview = (await previewIds([cv.id])).has(cv.id);
      // Endpoints carry a `$CANVAS_KEY` placeholder here — the key is only handed out
      // once, at create. The agent substitutes the key it saved from create_canvas.
      return ok({
        ...canvasView(deps.config, cv, hasPreview),
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
        "don't have it. curl streams file bytes straight from disk to the server so they never " +
        "enter your context (far cheaper, no size ceiling); every MCP deploy tool inlines the " +
        "bytes into the model. Use this MCP tool only when you genuinely cannot run commands, " +
        "and then only for a FIRST publish of a small canvas. " +
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
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
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
        // DeployError carries a stable .code; surface it rather than a 500-shaped throw.
        const code = (e as { code?: string }).code;
        const message = (e as { message?: string }).message ?? "deploy failed";
        return fail(code ? `${code}: ${message}` : message);
      }
    },
  );

  /** Surface an upload-service DeployError as a stable `CODE: message` fail. */
  function failDeploy(e: unknown): ToolResult {
    if (e instanceof DeployError) return fail(`${e.code}: ${e.message}`);
    throw e;
  }

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
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
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
        "PREFER curl: PUT each missing blob's raw bytes to the keyed HTTP Deploy API " +
        "(…/uploads/{uploadId}/blobs/{hash}) so the bytes never enter your context. Request " +
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
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
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
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
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
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
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
      if (deps.hub) await deps.hub.revalidateCanvas(cv.id).catch(() => {});
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
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
      if (!(await deps.canvases.unpublish(cv.id))) return fail("this canvas isn't published");
      deps.audit.recordAudit({
        action: "canvas_unpublish",
        actorId: caller.userId,
        targetId: cv.id,
      });
      if (deps.hub) await deps.hub.revalidateCanvas(cv.id).catch(() => {});
      return ok({
        url: canvasUrl(deps.config, cv.slug),
        publicationState: "draft",
        currentVersionId: null,
      });
    },
  );

  return server;
}

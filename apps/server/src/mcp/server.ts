import { Buffer } from "node:buffer";
import type { Config } from "@canvas-drop/shared";
import { type CanvasStatus, publicationState } from "@canvas-drop/shared/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit/audit-log.js";
import { generateApiKey, hashApiKey } from "../canvas/api-key.js";
import { generateUniqueSlug } from "../canvas/slug.js";
import { canvasUrl } from "../canvas/url.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { UsersRepository } from "../db/repositories/users.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { DeployEngine } from "../deploy/engine.js";
import { DeployError } from "../deploy/errors.js";
import { fromFilesArray, fromZip } from "../deploy/ingest.js";
import type { RealtimeHub } from "../realtime/hub.js";
import type { UploadService } from "../upload/service.js";

export interface McpToolDeps {
  config: Config;
  users: UsersRepository;
  canvases: CanvasesRepository;
  versions: VersionsRepository;
  engine: DeployEngine;
  upload: UploadService;
  audit: AuditLog;
  hub?: RealtimeHub;
}

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
) {
  return {
    id: cv.id,
    slug: cv.slug,
    url: canvasUrl(config, cv.slug),
    title: cv.title,
    status: cv.status,
    publicationState: publicationState(cv.status as CanvasStatus, cv.currentVersionId !== null),
    currentVersionId: cv.currentVersionId,
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
      return ok({ total, canvases: items.map((cv) => canvasView(deps.config, cv)) });
    },
  );

  server.registerTool(
    "create_canvas",
    {
      description:
        "Create a new canvas you own. Returns its id, URL, and a one-time deploy API key.",
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
      return ok({ ...canvasView(deps.config, cv), apiKey });
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
      return ok(canvasView(deps.config, cv));
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
        "Deploy static files to a canvas you own in a single call. Provide EITHER a base64 ZIP " +
        "(zipBase64) OR a files array (text as UTF-8, binary as base64) — not both. For large " +
        "or incremental deploys use begin_deploy/add_files/finalize_deploy instead.",
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
        "Open a staged upload for a canvas you own. Give the file manifest (path, sha256 hash, " +
        "size); returns an uploadId and the subset of hashes you still need to send via " +
        "add_files. Follow with add_files then finalize_deploy.",
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
        "base64. Call repeatedly to chunk a large set; only send the hashes begin_deploy reported missing.",
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
        "Publish a new live version from a staged upload (from begin_deploy). Single-use; fails " +
        "if any manifest blob is still missing.",
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

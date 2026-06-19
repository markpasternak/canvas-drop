import { Buffer } from "node:buffer";
import type { Canvas, Manifest } from "@canvas-drop/shared/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { liveManifest, manifestsEqual } from "../canvas/manifest.js";
import { isTextContentType, mimeFor } from "../canvas/mime.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import type { DraftService } from "../draft/service.js";
import type { McpCaller, RequireMutable } from "./server.js";
import { fail, failDeploy, ok } from "./tool-kit.js";

interface DraftToolDeps {
  versions: VersionsRepository;
  drafts: DraftService;
}

/**
 * The browser-editor parity tools — get/read/write/delete/rename a canvas's mutable
 * DRAFT, publish it as a version, or restore a published version into it. Split out of
 * `server.ts` to keep the tool registry under the file-size bar; each tool still wraps
 * the same DraftService the `/api/canvases/:id/draft*` routes use, gated by the shared
 * `requireOwned` owner check (no existence leak, §12.0). Draft READS (get/read) use
 * `requireOwned`; draft EDITS (write/delete/rename/publish/restore) use `requireMutable`,
 * so a disabled (admin-taken-down) canvas is read-only to its owner here too — exactly
 * as on the HTTP draft routes (the shared DISABLED contract).
 */
export function registerDraftTools(
  server: McpServer,
  deps: DraftToolDeps,
  caller: McpCaller,
  requireOwned: (id: string) => Promise<Canvas | null>,
  requireMutable: RequireMutable,
): void {
  /** Serialize a draft like the editor's draftView (file list + dirty/stale state). */
  async function draftViewFor(
    cv: { currentVersionId: string | null },
    draft: { manifest: unknown; stale: boolean; baseVersionId: string | null; updatedAt: number },
  ) {
    const manifest = draft.manifest as Manifest;
    const live = await liveManifest(deps.versions, cv.currentVersionId);
    const files = Object.entries(manifest)
      .map(([path, e]) => ({ path, size: e.size, mime: e.mime }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const dirty = live
      ? !manifestsEqual(manifest, live.manifest)
      : Object.keys(manifest).length > 0;
    return {
      files,
      stale: draft.stale,
      baseVersionId: draft.baseVersionId,
      updatedAt: draft.updatedAt,
      dirty,
    };
  }

  server.registerTool(
    "get_draft",
    {
      description:
        "Get the editor DRAFT of a canvas you own — its file list + state (dirty = differs from the " +
        "live version). Creates the draft from the live version on first open. Use read_draft_file " +
        "for contents, write/delete/rename to edit, then publish_draft.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
      return ok(await draftViewFor(cv, await deps.drafts.getOrCreate(cv)));
    },
  );

  server.registerTool(
    "read_draft_file",
    {
      description:
        "Read one file's content from the DRAFT of a canvas you own (text as UTF-8, binary as " +
        "base64). For the live version use get_canvas_file instead.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        path: z.string().describe("File path within the draft."),
      },
    },
    async ({ id, path }) => {
      const cv = await requireOwned(id);
      if (!cv) return fail("canvas not found");
      const bytes = await deps.drafts.readFile(cv, path);
      if (!bytes) return fail(`no draft file at "${path}"`);
      const text = isTextContentType(mimeFor(path).contentType);
      return ok({
        path,
        encoding: text ? "utf8" : "base64",
        content: Buffer.from(bytes).toString(text ? "utf8" : "base64"),
      });
    },
  );

  server.registerTool(
    "write_draft_file",
    {
      description:
        "Write/replace a file in the DRAFT of a canvas you own (text as utf8, binary as base64). " +
        "Set create=true to refuse overwriting an existing path. Returns the updated draft view. " +
        "Publish with publish_draft when ready.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        path: z.string().describe("File path within the draft."),
        content: z.string().describe("File content."),
        encoding: z.enum(["utf8", "base64"]).optional().describe("Defaults to utf8."),
        create: z
          .boolean()
          .optional()
          .describe("If true, fail rather than overwrite an existing file."),
      },
    },
    async ({ id, path, content, encoding, create }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      const bytes = new Uint8Array(Buffer.from(content, encoding === "base64" ? "base64" : "utf8"));
      try {
        const draft = await deps.drafts.writeFile(cv, path, bytes, {
          mustNotExist: create === true,
        });
        return ok(await draftViewFor(cv, draft));
      } catch (e) {
        return failDeploy(e);
      }
    },
  );

  server.registerTool(
    "delete_draft_file",
    {
      description:
        "Delete a file from the DRAFT of a canvas you own. Returns the updated draft view.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        path: z.string().describe("File path within the draft."),
      },
    },
    async ({ id, path }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      try {
        return ok(await draftViewFor(cv, await deps.drafts.deleteFile(cv, path)));
      } catch (e) {
        return failDeploy(e);
      }
    },
  );

  server.registerTool(
    "rename_draft_file",
    {
      description:
        "Rename/move a file within the DRAFT of a canvas you own. Returns the updated draft view.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        from: z.string().describe("Current path."),
        to: z.string().describe("New path."),
      },
    },
    async ({ id, from, to }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      try {
        return ok(await draftViewFor(cv, await deps.drafts.renameFile(cv, from, to)));
      } catch (e) {
        return failDeploy(e);
      }
    },
  );

  server.registerTool(
    "publish_draft",
    {
      description:
        "Publish the DRAFT of a canvas you own as a new live version (the editor's Publish button). " +
        "Fails NOT_ACTIVE if the canvas is archived/disabled. Returns the new version's details.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      // A disabled canvas rejects with the shared DISABLED contract; an archived one keeps
      // the NOT_ACTIVE "unarchive first" message (requireMutable only catches disabled).
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      if (cv.status !== "active")
        return fail("NOT_ACTIVE: unarchive this canvas before publishing");
      try {
        return ok(await deps.drafts.publish(cv, caller.userId));
      } catch (e) {
        return failDeploy(e);
      }
    },
  );

  server.registerTool(
    "restore_draft",
    {
      description:
        "Reset the DRAFT of a canvas you own to a previously published version's files (the editor's " +
        "Restore). Pass the version number. Returns the updated draft view.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        version: z
          .number()
          .int()
          .positive()
          .describe("The version number to restore into the draft."),
      },
    },
    async ({ id, version }) => {
      const gate = await requireMutable(id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      try {
        return ok(await draftViewFor(cv, await deps.drafts.restore(cv, version)));
      } catch (e) {
        return failDeploy(e);
      }
    },
  );
}

import { Buffer } from "node:buffer";
import type { Draft } from "@canvas-drop/shared/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { liveManifest } from "../canvas/manifest.js";
import { isTextContentType, mimeFor } from "../canvas/mime.js";
import type { VersionsRepository } from "../db/repositories/versions.js";
import { DraftConflictError } from "../deploy/errors.js";
import type { DraftService } from "../draft/service.js";
import type { McpCaller, RequireMutable, RequireRole } from "./server.js";
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
 * role check (owner or editor; no existence leak for a no-role caller, §12.0). Draft
 * READS (get/read) use `requireRole`; draft EDITS (write/delete/rename/publish/restore)
 * use `requireMutable`, so a disabled (admin-taken-down) canvas is read-only here too —
 * exactly as on the HTTP draft routes (the shared DISABLED contract).
 */
export function registerDraftTools(
  server: McpServer,
  deps: DraftToolDeps,
  caller: McpCaller,
  requireRole: RequireRole,
  requireMutable: RequireMutable,
): void {
  /** The draft as the editor sees it — the SAME projection the HTTP draft view returns
   *  (per-file `hash` + last writer, so `expectedHash` on the next write is one call). */
  async function draftViewFor(cv: { currentVersionId: string | null }, draft: Draft) {
    const live = await liveManifest(deps.versions, cv.currentVersionId);
    return deps.drafts.describe(draft, live?.manifest ?? null);
  }

  /** The conflict message: the `DRAFT_CONFLICT:` prefix carrying the same fields as HTTP. */
  function failConflictOrDeploy(e: unknown) {
    if (e instanceof DraftConflictError) {
      const c = e.conflict;
      return fail(
        `DRAFT_CONFLICT: ${e.message} (path=${c.path} currentHash=${c.currentHash} ` +
          `updatedBy=${c.updatedBy ?? "-"} updatedByName=${c.updatedByName ?? "-"} ` +
          `updatedAt=${c.updatedAt ?? "-"}). Re-read with get_draft / read_draft_file and ` +
          "retry with expectedHash set to currentHash.",
      );
    }
    return failDeploy(e);
  }

  const expectedHashParam = z
    .string()
    .optional()
    .describe(
      "Optimistic-concurrency guard: the file's `hash` from get_draft / read_draft_file (or " +
        "the literal 'none' for a path you believe absent). A mismatch fails with " +
        "DRAFT_CONFLICT naming the last writer. When omitted, the write still fails with " +
        "DRAFT_CONFLICT if a DIFFERENT user wrote this file last — your own solo edits never conflict.",
    );

  server.registerTool(
    "get_draft",
    {
      description:
        "Get the editor DRAFT of a canvas you own or edit — its file list + state (dirty = differs from the " +
        "live version). Creates the draft from the live version on first open. Use read_draft_file " +
        "for contents, write/delete/rename to edit, then publish_draft.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      const gate = await requireRole("get_draft", id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      return ok(await draftViewFor(cv, await deps.drafts.getOrCreate(cv)));
    },
  );

  server.registerTool(
    "read_draft_file",
    {
      description:
        "Read one file's content from the DRAFT of a canvas you own or edit (text as UTF-8, binary as " +
        "base64). For the live version use get_canvas_file instead.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        path: z.string().describe("File path within the draft."),
      },
    },
    async ({ id, path }) => {
      const gate = await requireRole("read_draft_file", id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      const bytes = await deps.drafts.readFile(cv, path);
      if (!bytes) return fail(`no draft file at "${path}"`);
      const text = isTextContentType(mimeFor(path).contentType);
      // The entry's hash + last writer ride along so a following write can carry the
      // precondition (editor-roles plan, KTD8).
      const view = await draftViewFor(cv, await deps.drafts.getOrCreate(cv));
      const entry = view.files.find((f) => f.path === path);
      return ok({
        path,
        encoding: text ? "utf8" : "base64",
        content: Buffer.from(bytes).toString(text ? "utf8" : "base64"),
        hash: entry?.hash ?? null,
        updatedBy: entry?.updatedBy ?? null,
        updatedByName: entry?.updatedByName ?? null,
        updatedAt: entry?.updatedAt ?? null,
      });
    },
  );

  server.registerTool(
    "write_draft_file",
    {
      description:
        "Write/replace a file in the DRAFT of a canvas you own or edit (text as utf8, binary as base64). " +
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
        expectedHash: expectedHashParam,
      },
    },
    async ({ id, path, content, encoding, create, expectedHash }) => {
      const gate = await requireMutable("write_draft_file", id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      const bytes = new Uint8Array(Buffer.from(content, encoding === "base64" ? "base64" : "utf8"));
      try {
        const draft = await deps.drafts.writeFile(cv, path, bytes, {
          mustNotExist: create === true,
          actor: caller.userId,
          expectedHash,
        });
        return ok(await draftViewFor(cv, draft));
      } catch (e) {
        return failConflictOrDeploy(e);
      }
    },
  );

  server.registerTool(
    "delete_draft_file",
    {
      description:
        "Delete a file from the DRAFT of a canvas you own or edit. Returns the updated draft view.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        path: z.string().describe("File path within the draft."),
        expectedHash: expectedHashParam,
      },
    },
    async ({ id, path, expectedHash }) => {
      const gate = await requireMutable("delete_draft_file", id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      try {
        return ok(
          await draftViewFor(
            cv,
            await deps.drafts.deleteFile(cv, path, { actor: caller.userId, expectedHash }),
          ),
        );
      } catch (e) {
        return failConflictOrDeploy(e);
      }
    },
  );

  server.registerTool(
    "rename_draft_file",
    {
      description:
        "Rename/move a file within the DRAFT of a canvas you own or edit. Returns the updated draft view.",
      inputSchema: {
        id: z.string().describe("The canvas id."),
        from: z.string().describe("Current path."),
        to: z.string().describe("New path."),
        expectedHash: expectedHashParam,
      },
    },
    async ({ id, from, to, expectedHash }) => {
      const gate = await requireMutable("rename_draft_file", id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      try {
        return ok(
          await draftViewFor(
            cv,
            await deps.drafts.renameFile(cv, from, to, { actor: caller.userId, expectedHash }),
          ),
        );
      } catch (e) {
        return failConflictOrDeploy(e);
      }
    },
  );

  server.registerTool(
    "publish_draft",
    {
      description:
        "Publish the DRAFT of a canvas you own or edit as a new live version (the editor's Publish button). " +
        "Fails DISABLED if an admin has taken down the canvas, or NOT_ACTIVE if it is archived. " +
        "Returns the new version details.",
      inputSchema: { id: z.string().describe("The canvas id.") },
    },
    async ({ id }) => {
      // A disabled canvas rejects with the shared DISABLED contract; an archived one keeps
      // the NOT_ACTIVE "unarchive first" message (requireMutable only catches disabled).
      const gate = await requireMutable("publish_draft", id);
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
        "Reset the DRAFT of a canvas you own or edit to a previously published version's files (the editor's " +
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
      const gate = await requireMutable("restore_draft", id);
      if ("error" in gate) return gate.error;
      const cv = gate.canvas;
      try {
        return ok(await draftViewFor(cv, await deps.drafts.restore(cv, version, caller.userId)));
      } catch (e) {
        return failDeploy(e);
      }
    },
  );
}

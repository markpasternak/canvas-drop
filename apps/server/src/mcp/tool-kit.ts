import type { Config } from "@canvas-drop/shared";
import { type CanvasStatus, publicationState } from "@canvas-drop/shared/db";
import { canvasUrl } from "../canvas/url.js";
import { DeployError } from "../deploy/errors.js";

/** The MCP tool return envelope. `isError` marks a tool-level failure. */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Success: a pretty-printed JSON payload. */
export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Failure: a plain `message` (often `CODE: detail`) with `isError`. */
export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Surface an upload/deploy `DeployError` as a stable `CODE: message` fail; rethrow
 *  anything else (a real bug, not a client error). Shared by every deploy/draft tool. */
export function failDeploy(e: unknown): ToolResult {
  if (e instanceof DeployError) return fail(`${e.code}: ${e.message}`);
  throw e;
}

/** The owner-facing canvas projection returned by most tools (never a secret). */
export function canvasView(
  config: Config,
  cv: { id: string; slug: string; title: string; status: string; currentVersionId: string | null },
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

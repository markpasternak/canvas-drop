import type { Config } from "@canvas-drop/shared";
import { type CanvasStatus, publicationState } from "@canvas-drop/shared/db";
import { canvasUrl } from "../canvas/url.js";
import { DeployError } from "../deploy/errors.js";
import { PREVIEW_ASSET_PATH } from "../screenshots/serve.js";

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
  cv: {
    id: string;
    slug: string;
    title: string;
    status: string;
    currentVersionId: string | null;
    previewMode: string;
  },
  // A captured screenshot preview exists (plan 004). When true, `previewUrl` points at
  // the access-gated cover (`card` rendition) so an agent can surface it the way the
  // dashboard does. Defaults false → no preview (pipeline off / not yet captured).
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
    // Preview policy (plan 004): auto/off/custom — so an agent can read the current
    // setting before changing it (parity with the dashboard Preview control).
    previewMode: cv.previewMode,
    hasPreview,
    ...(hasPreview
      ? { previewUrl: `${url.replace(/\/$/, "")}/${PREVIEW_ASSET_PATH}?rendition=card` }
      : {}),
  };
}

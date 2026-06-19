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

/** The owner-facing canvas projection returned by most tools (never a secret). It
 *  echoes every field an agent can set via `update_canvas` / `set_capabilities` so a
 *  write is confirmable from the response (read-your-writes) without a follow-up call —
 *  parity with the HTTP PATCH `/settings` projection. The password hash itself is never
 *  exposed; `hasPassword` reports only whether a gate is set. */
export function canvasView(
  config: Config,
  cv: {
    id: string;
    slug: string;
    title: string;
    description?: string | null;
    // `status`/`previewMode`/`access` are stored as plain text columns (no `$type` on
    // the dual-dialect schema), so they widen to `string` on the inferred `Canvas` type;
    // the cast below narrows at this single boundary. Tightening the columns to
    // `$type<CanvasStatus>()` etc. (schema.pg.ts + schema.sqlite.ts) would let us drop it.
    status: string;
    currentVersionId: string | null;
    previewMode: string;
    access?: string;
    passwordHash?: string | null;
    sharedExpiresAt?: number | null;
    spaFallback?: boolean;
    backendEnabled?: boolean;
    disabledReason?: string | null;
    galleryListed?: boolean;
    galleryTemplatable?: boolean;
    gallerySummary?: string | null;
    tags?: unknown;
    guestAiEnabled?: boolean;
    guestAiCap?: number;
    viewCount: number;
    lastViewedAt: number | null;
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
    description: cv.description ?? null,
    status: cv.status,
    publicationState: publicationState(cv.status as CanvasStatus, cv.currentVersionId !== null),
    currentVersionId: cv.currentVersionId,
    // Sharing / settings fields (parity with the Settings + Share dashboard tabs) so an
    // agent can confirm an `update_canvas` write from this response, not a second call.
    access: cv.access,
    hasPassword: cv.passwordHash != null,
    sharedExpiresAt: cv.sharedExpiresAt ?? null,
    spaFallback: cv.spaFallback,
    backendEnabled: cv.backendEnabled,
    disabledReason: cv.disabledReason ?? null,
    galleryListed: cv.galleryListed,
    galleryTemplatable: cv.galleryTemplatable,
    gallerySummary: cv.gallerySummary ?? null,
    tags: cv.tags,
    guestAiEnabled: cv.guestAiEnabled,
    guestAiCap: cv.guestAiCap,
    // Preview policy (plan 004): auto/off/custom — so an agent can read the current
    // setting before changing it (parity with the dashboard Preview control).
    previewMode: cv.previewMode,
    // Denormalized view rollups (plan 004): lifetime deduped views + last-viewed stamp,
    // so an agent reads the same popularity signal the dashboard shows. Trending
    // (recent-window) counts ride `list_canvases` as `recentViews`.
    viewCount: cv.viewCount,
    lastViewedAt: cv.lastViewedAt,
    hasPreview,
    ...(hasPreview
      ? { previewUrl: `${url.replace(/\/$/, "")}/${PREVIEW_ASSET_PATH}?rendition=card` }
      : {}),
  };
}

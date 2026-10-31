import type { Canvas } from "@canvas-drop/shared/db";

/**
 * Link previews for canvases that are not an ungated public link: what a signed-out
 * link unfurler (Slack, iMessage, …) may learn about the canvas.
 *
 * Two inputs decide it:
 *  - the per-canvas choice (`link_preview_mode`): `on`, `off`, or NULL = follow the
 *    instance default;
 *  - the instance default (`access.linkPreviewDefault`, admin-set), which applies to
 *    **whole-org** canvases only. A restricted canvas or a password-protected public
 *    link reveals nothing until its owner or an editor turns the preview on.
 *
 * The levels: `none` (the generic sign-in card), `title` (title + description, brand
 * image) and `cover` (also the CUSTOM cover). An automatic screenshot can show real
 * content, so it is never part of a gated canvas's preview at any level.
 */

export const LINK_PREVIEW_DEFAULTS = ["off", "title", "cover"] as const;
export type LinkPreviewDefault = (typeof LINK_PREVIEW_DEFAULTS)[number];
export type LinkPreviewLevel = "none" | "title" | "cover";

export function isLinkPreviewDefault(v: unknown): v is LinkPreviewDefault {
  return typeof v === "string" && (LINK_PREVIEW_DEFAULTS as readonly string[]).includes(v);
}

/** The stored column value for an API choice (true / false / null = default). */
export function linkPreviewModeOf(choice: boolean | null): "on" | "off" | null {
  return choice === null ? null : choice ? "on" : "off";
}

/** The API choice for a stored column value: true = on, false = off, null = default. */
export function linkPreviewChoice(cv: Pick<Canvas, "linkPreviewMode">): boolean | null {
  if (cv.linkPreviewMode === "on") return true;
  if (cv.linkPreviewMode === "off") return false;
  return null;
}

/** Whether a canvas is live enough to unfurl: active, published and unexpired. */
function isLive(
  cv: Pick<Canvas, "status" | "currentVersionId" | "sharedExpiresAt">,
  now: number,
): boolean {
  return (
    cv.status === "active" &&
    cv.currentVersionId !== null &&
    (cv.sharedExpiresAt === null || cv.sharedExpiresAt > now)
  );
}

/**
 * What the canvas's choice resolves to, ignoring liveness. `on` reveals the custom cover
 * too (the per-canvas switch has always meant title + description + custom cover).
 */
export function configuredLinkPreview(
  cv: Pick<Canvas, "linkPreviewMode" | "access">,
  instanceDefault: LinkPreviewDefault,
): LinkPreviewLevel {
  const choice = linkPreviewChoice(cv);
  if (choice === true) return "cover";
  if (choice === false) return "none";
  if (cv.access !== "whole_org") return "none";
  return instanceDefault === "off" ? "none" : instanceDefault;
}

/** The effective preview level a signed-out unfurler gets for this canvas right now. */
export function linkPreviewLevel(
  cv: Pick<
    Canvas,
    "linkPreviewMode" | "access" | "status" | "currentVersionId" | "sharedExpiresAt"
  >,
  instanceDefault: LinkPreviewDefault,
  now: number,
): LinkPreviewLevel {
  if (!isLive(cv, now)) return "none";
  return configuredLinkPreview(cv, instanceDefault);
}

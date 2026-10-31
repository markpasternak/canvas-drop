import type { Canvas, LinkPreviewDefault } from "./api.js";

/**
 * The canvas settings link-preview toggle's state. A canvas with no choice of its own
 * (`linkPreview === null`) follows the admin default, which applies to whole-org canvases
 * only (mirrors the server's `configuredLinkPreview`).
 */
export function linkPreviewToggleState(
  canvas: Pick<Canvas, "access" | "linkPreview">,
  instanceDefault: LinkPreviewDefault | undefined,
): { on: boolean; note: string | null; resettable: boolean } {
  const orgDefault = canvas.access === "whole_org" ? (instanceDefault ?? "off") : "off";
  const following = canvas.linkPreview === null;
  if (following) {
    return {
      on: orgDefault !== "off",
      note:
        orgDefault === "title"
          ? "On by your organization's default, which shows the title and description only."
          : orgDefault === "cover"
            ? "On by your organization's default."
            : null,
      resettable: false,
    };
  }
  // An explicit choice on a canvas the default covers can go back to following it.
  return { on: canvas.linkPreview === true, note: null, resettable: orgDefault !== "off" };
}

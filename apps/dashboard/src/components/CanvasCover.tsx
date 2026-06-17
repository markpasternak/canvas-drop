import { useState } from "react";
import { cn } from "../lib/cn.js";
import { GenerativeCover } from "./GenerativeCover.js";

/**
 * A canvas cover (plan 004 / U8). Shows the real screenshot preview when one exists,
 * falling back to the deterministic {@link GenerativeCover} otherwise — so a canvas is
 * never blank and the page behaves exactly like today when the screenshot pipeline is
 * off (the preview route 404s → `onError` → generative art).
 *
 * v1 reads on load (no live swap; the realtime "ready" ping is deferred). The cover
 * URL is the access-gated preview route on the canvas's own origin, so the browser's
 * session cookie authorizes it (a private canvas's cover only loads for someone allowed
 * to see the canvas — R5).
 */
const PREVIEW_PATH = "__canvasdrop_preview";

/** Build the preview cover URL for a canvas's public URL + rendition (card by default). */
export function previewCoverUrl(
  canvasUrl: string,
  rendition: "card" | "thumb" | "og" = "card",
): string {
  return `${canvasUrl.replace(/\/$/, "")}/${PREVIEW_PATH}?rendition=${rendition}`;
}

export function CanvasCover({
  seed,
  previewUrl,
  className,
}: {
  /** Stable seed for the generative fallback (the canvas id). */
  seed: string;
  /** The preview route URL; omit to always show the generative cover. */
  previewUrl?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!previewUrl || failed) return <GenerativeCover seed={seed} className={className} />;
  return (
    // Decorative — the card's title is the labelled affordance, so the cover is aria-hidden.
    <img
      src={previewUrl}
      alt=""
      aria-hidden
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("size-full object-cover", className)}
    />
  );
}

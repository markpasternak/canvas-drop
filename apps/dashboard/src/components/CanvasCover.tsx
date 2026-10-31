import { useState } from "react";
import { cn } from "../lib/cn.js";
import { type CoverContent, GenerativeCover } from "./GenerativeCover.js";

/**
 * A canvas cover (plan 004 / U8; content-aware fallback in UX-sweep U6). Shows the real
 * screenshot preview when one exists, falling back to the deterministic content-aware
 * {@link GenerativeCover} otherwise — so a canvas is never blank and the page behaves
 * exactly like today when the screenshot pipeline is off (the preview route 404s →
 * `onError` → generative art).
 *
 * v1 reads on load (no live swap; the realtime "ready" ping is deferred). The cover
 * URL is the access-gated preview route on the canvas's own origin, so the browser's
 * session cookie authorizes it (a private canvas's cover only loads for someone allowed
 * to see the canvas — R5).
 *
 * The `title`/`type`/`status` content props are passed straight to the fallback; they
 * are unused on the screenshot path (the real preview needs no overlay) and stay
 * `aria-hidden` either way. `plain` forwards to the fallback's pure-background mode —
 * the full-bleed grid card sets it so the seeded mesh carries NO baked-in title/marker
 * (the card overlay owns the text); the standalone detail/settings preview leaves it off
 * so the content-aware overlay still aids recognition when no screenshot exists.
 */
const PREVIEW_PATH = "__canvasdrop_preview";

/** Build the preview cover URL for a canvas's public URL + rendition (card by default). */
export function previewCoverUrl(
  canvasUrl: string,
  rendition: "card" | "thumb" | "og" = "card",
): string {
  // `cors=1` keys the CORS-mode request apart from cached no-cors responses of the same
  // URL, which carry no Access-Control-Allow-Origin and would fail the check.
  return `${canvasUrl.replace(/\/$/, "")}/${PREVIEW_PATH}?rendition=${rendition}&cors=1`;
}

/**
 * A cover on another host (subdomain mode) is requested in CORS mode with credentials.
 * A restricted canvas answers plain cross-origin embeds with
 * `Cross-Origin-Resource-Policy: same-origin`, so other canvases can't probe access
 * through it; its preview route allows the dashboard's origin instead. Same-host covers
 * (path mode, and dev's :5173 → :3000) load as before.
 */
export function coverCrossOrigin(previewUrl: string): "use-credentials" | undefined {
  try {
    return new URL(previewUrl, window.location.href).hostname === window.location.hostname
      ? undefined
      : "use-credentials";
  } catch {
    return undefined;
  }
}

export function CanvasCover({
  seed,
  previewUrl,
  className,
  title,
  type,
  status,
  plain,
}: {
  /** Stable seed for the generative fallback (the canvas id). */
  seed: string;
  /** The preview route URL; omit to always show the generative cover. */
  previewUrl?: string;
  className?: string;
} & CoverContent) {
  const [failed, setFailed] = useState(false);
  if (!previewUrl || failed)
    return (
      <GenerativeCover
        seed={seed}
        className={className}
        title={title}
        type={type}
        status={status}
        plain={plain}
      />
    );
  return (
    // Decorative — the card's title is the labelled affordance, so the cover is aria-hidden.
    <img
      src={previewUrl}
      crossOrigin={coverCrossOrigin(previewUrl)}
      alt=""
      aria-hidden
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("size-full object-cover", className)}
    />
  );
}

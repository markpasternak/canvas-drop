import type { Config } from "@canvas-drop/shared";

/**
 * Build the public URL for a canvas (§8.2). Subdomain mode → `{scheme}//{slug}.{host}/`;
 * path mode → `{base}/c/{slug}/`.
 */
export function canvasUrl(config: Config, slug: string): string {
  if (config.urlMode === "subdomain") {
    const base = new URL(config.baseUrl);
    return `${base.protocol}//${slug}.${base.host}/`;
  }
  return `${config.baseUrl.replace(/\/$/, "")}/c/${slug}/`;
}

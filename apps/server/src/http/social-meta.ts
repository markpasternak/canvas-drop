import { escapeHtml } from "./error-pages.js";

/**
 * Favicon / icon `<link>`s for the self-rendered public pages (landing, legal,
 * docs), mirroring the dashboard SPA's `index.html`. The targets are served
 * pre-gateway by `brandAssetRoutes`, so they resolve while signed out. Kept
 * separate from {@link ogMeta} (icons are page chrome, not SEO).
 */
export const FAVICON_LINKS = `<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/site.webmanifest">`;

/**
 * One consistent block of SEO + Open Graph + Twitter card tags for the indexable,
 * self-rendered public pages: the landing (`/`), legal (`/privacy`, `/terms`),
 * and docs (`/docs/*`). Centralizing it means every shared link unfurls
 * identically and the tags can't drift between surfaces. The image is the single
 * shared `/og.png` card (`pnpm og:build`).
 *
 * Deliberately excludes `theme-color` (page-chrome, not SEO; the legal pages are
 * light-only) and JSON-LD / `llms.txt` hints (landing-only). The signed-out
 * social-preview shells are a separate, intentionally `noindex` case and build
 * their own minimal tags.
 *
 * `origin` is `config.baseUrl` (crawlers require absolute URLs); `path` is the
 * page's absolute path (for `canonical` + `og:url`); `title` / `description` are
 * the page's own, already composed by the caller.
 */
export function ogMeta(opts: {
  origin: string;
  path: string;
  title: string;
  description: string;
}): string {
  const base = opts.origin.replace(/\/$/, "");
  const url = escapeHtml(`${base}${opts.path}`);
  const image = escapeHtml(`${base}/og.png`);
  const t = escapeHtml(opts.title);
  const d = escapeHtml(
    opts.description
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return `<meta name="description" content="${d}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="canvas-drop">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="canvas-drop: drop it in, share it out">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${image}">`;
}

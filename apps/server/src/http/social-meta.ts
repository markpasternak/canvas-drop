import { escapeHtml } from "./error-pages.js";

/**
 * One consistent block of SEO + Open Graph + Twitter card tags for the indexable,
 * self-rendered public pages — the landing (`/`), legal (`/privacy`, `/terms`),
 * and docs (`/docs/*`). Centralizing it means every shared link unfurls
 * identically and the tags can't drift between surfaces. The image is the single
 * shared `/og.png` card (`pnpm og:build`).
 *
 * Deliberately excludes `theme-color` (page-chrome, not SEO — the legal pages are
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
<meta property="og:image:alt" content="canvas-drop — drop it in, share it out">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${image}">`;
}

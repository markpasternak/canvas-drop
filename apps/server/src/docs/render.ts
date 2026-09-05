import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkinName } from "@canvas-drop/shared";
import { escapeHtml } from "../http/error-pages.js";
import { SITE_STYLES, SITE_THEME_SCRIPT, siteFooter, siteHeader } from "../http/site-chrome.js";
import { skinnedHtmlTag } from "../http/skin-html.js";
import { FAVICON_LINKS, ogMeta } from "../http/social-meta.js";
import { DOC_NAV, DOC_PAGES, type DocPage } from "./generated-content.js";
import { NAV_CLIENT_JS } from "./nav.client.js";
import { SEARCH_CLIENT_JS } from "./search.client.js";

// Content hash of the committed mermaid bundle, used to cache-bust the <script
// src>. The route serves the bundle `immutable, max-age=1y`, so without a version
// query a returning visitor would keep a STALE renderer forever after any bundle
// update. Hashing the file makes the URL change exactly when the bytes do — so
// `immutable` stays correct AND updates land immediately. Computed once at module
// load; if the bundle is absent we fall back to an unversioned tag.
const MERMAID_BUNDLE_VERSION = (() => {
  try {
    const p = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
      "docs/site/assets/mermaid.js",
    );
    return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 8);
  } catch {
    return "";
  }
})();

/**
 * Public documentation shares the marketing/legal chrome, with a dedicated
 * reading layout and native navigation disclosure. The desktop sidebar stays
 * open; a small enhancement collapses it on mobile. Without JavaScript the full
 * navigation remains available. Content is precompiled, sanitized HTML.
 */

const byPath = new Map<string, DocPage>(DOC_PAGES.map((p) => [p.path, p]));

/** Flat, ordered list of pages (nav order) for prev/next. */
const FLAT = DOC_NAV.flatMap((s) => s.pages);

function href(path: string): string {
  return path === "" ? "/docs" : `/docs/${path}`;
}

const SEARCH_VERSION = createHash("sha256").update(SEARCH_CLIENT_JS).digest("hex").slice(0, 8);
const NAV_VERSION = createHash("sha256").update(NAV_CLIENT_JS).digest("hex").slice(0, 8);

const DOCS_STYLES = `${SITE_STYLES}
  .layout { display: grid; grid-template-columns: 16rem minmax(0, 1fr); max-width: 78rem; margin: 0 auto; padding-inline: clamp(1.25rem, 5vw, 3.5rem); gap: clamp(2rem, 4vw, 4rem); }
  .docs-navigation { position: sticky; top: var(--site-header-height); align-self: start; max-height: calc(100dvh - var(--site-header-height)); overflow-y: auto; padding-block: 2rem; }
  .docs-navigation > summary { display: none; }
  .sidebar { padding: 0 .5rem .5rem 0; }
  .search { display: none; margin-bottom: 1rem; position: relative; }
  .has-js .search { display: block; }
  .search input {
    width: 100%; padding: .5rem .65rem; font: inherit; font-size: 1rem; min-height: 44px;
    color: var(--fg); background: var(--surface); border: 1px solid var(--border); border-radius: .5rem;
  }
  .search input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .search-results {
    position: absolute; left: 0; right: 0; margin-top: .25rem; z-index: 30;
    background: var(--surface-raised); border: 1px solid var(--border); border-radius: .5rem;
    box-shadow: 0 8px 24px #0002; max-height: 22rem; overflow-y: auto;
  }
  .search-results:empty { display: none; }
  .search-results a, .search-results .empty {
    display: block; min-height: 44px; padding: .6rem .65rem; font-size: .875rem; color: var(--fg); text-decoration: none;
  }
  .search-results a:hover { background: var(--surface-sunken); }
  .search-results .empty { color: var(--subtle); }
  nav.toc h2 { margin: 1.5rem 0 .5rem; font-size: .8125rem; font-weight: 600; color: var(--fg); }
  nav.toc ul { list-style: none; margin: 0 0 .5rem; padding: 0; }
  nav.toc a {
    display: flex; align-items: center; min-height: 2.5rem; padding: .4rem .65rem; border-radius: calc(.375rem * var(--radius-scale));
    color: var(--muted); text-decoration: none; font-size: .875rem;
  }
  nav.toc a:hover { background: var(--surface-sunken); color: var(--fg); }
  nav.toc a[aria-current="page"] { background: var(--accent-subtle); color: var(--accent); font-weight: 600; }
  .content {
    min-width: 0; width: auto; max-width: none;
    padding-block: clamp(2rem, 4vw, 3.5rem);
  }
  .doc { max-width: 46rem; overflow-wrap: anywhere; }
  .doc img { display: block; max-width: 100%; height: auto; border-radius: .75rem; }
  .doc h1, .doc h2, .doc h3 { font-family: var(--font-display); font-optical-sizing: auto; font-weight: var(--display-weight, 500); letter-spacing: var(--display-tracking, -.02em); }
  .doc h1 { margin: 0 0 1rem; font-size: clamp(1.7rem, 5vw, 2.3rem); line-height: 1.1; letter-spacing: -.02em; }
  /* Lede treatment: the page's opening heading reads larger, and the intro
     paragraph that follows it is set as a muted lede with a hairline rule, so each
     doc opens deliberately instead of dropping straight into body copy. */
  .doc > h1:first-child { font-size: clamp(2rem, 5vw, 2.75rem); letter-spacing: -.028em; margin-bottom: .85rem; }
  .doc > h1:first-child + p { font-size: 1.075rem; line-height: 1.65; color: var(--muted); padding-bottom: 1.4rem; margin-bottom: 1.6rem; border-bottom: 1px solid var(--border); }
  .doc h2 { margin: 2rem 0 .6rem; font-size: 1.25rem; letter-spacing: -.01em; scroll-margin-top: 1rem; }
  .doc h3 { margin: 1.5rem 0 .5rem; font-size: 1.05rem; scroll-margin-top: 1rem; }
  .doc p, .doc li { color: var(--muted); }
  .doc a { color: var(--accent); text-decoration: none; }
  .doc a:hover { text-decoration: underline; }
  .doc code { font-size: .85em; background: var(--surface-sunken); padding: .1em .35em; border-radius: .3rem; }
  .doc pre { margin: 1rem 0; padding: 1rem; overflow-x: auto; background: var(--surface-sunken); border: 1px solid var(--border); border-radius: .6rem; }
  .doc pre code { background: none; padding: 0; font-size: .8125rem; line-height: 1.5; }
  .doc-table { margin: 1.5rem 0; overflow-x: auto; border: 1px solid var(--border); border-radius: calc(.6rem * var(--radius-scale)); }
  .doc table { width: 100%; min-width: 36rem; border-collapse: collapse; font-size: .875rem; overflow-wrap: normal; }
  .doc th, .doc td { min-width: 9rem; text-align: left; vertical-align: top; padding: .75rem 1rem; border-bottom: 1px solid var(--border); overflow-wrap: break-word; }
  .doc th { color: var(--fg); background: var(--surface-sunken); font-weight: 600; white-space: nowrap; }
  .doc tr:last-child td { border-bottom: 0; }
  .doc blockquote { margin: 1rem 0; padding: .75rem 1rem; border-left: 3px solid var(--accent); background: var(--accent-subtle); border-radius: 0 .5rem .5rem 0; }
  .doc blockquote p { margin: .25rem 0; color: var(--fg); }
  /* minimal hljs token colors (token classes emitted at build time) */
  .hljs-keyword, .hljs-built_in, .hljs-literal { color: #8250df; }
  .hljs-string, .hljs-attr { color: #0a7d28; }
  .hljs-comment { color: var(--subtle); font-style: italic; }
  .hljs-title, .hljs-section, .hljs-name { color: #1f6feb; }
  .hljs-number { color: #b5500a; }
  .prevnext { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); }
  .prevnext a { display: inline-flex; align-items: center; min-height: 44px; color: var(--accent); text-decoration: none; font-size: .875rem; }
  @media (max-width: 48rem) {
    .layout { display: block; }
    .docs-navigation { position: static; max-height: none; padding: 0; border-bottom: 1px solid var(--border); }
    .docs-navigation > summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 3.5rem; padding-block: .65rem; cursor: pointer; list-style: none; font-size: .875rem; font-weight: 550; }
    .docs-navigation > summary::-webkit-details-marker { display: none; }
    .docs-navigation > summary::after { content: "+"; color: var(--accent); font-size: 1.25rem; }
    .docs-navigation[open] > summary::after { content: "−"; }
    .sidebar { padding: .5rem 0 1.5rem; }
    nav.toc a { min-height: 44px; }
    .content { padding-block: 2rem 3rem; }
  }
  /* dark syntax colors: when following the OS (no explicit data-theme) and dark,
     or when dark is explicitly chosen. The \`:root[data-theme="dark"]\` selectors
     also outrank the light defaults above so an explicit dark choice wins on a
     light OS. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme]) .hljs-keyword, :root:not([data-theme]) .hljs-built_in, :root:not([data-theme]) .hljs-literal { color: #d2a8ff; }
    :root:not([data-theme]) .hljs-string, :root:not([data-theme]) .hljs-attr { color: #7ee787; }
    :root:not([data-theme]) .hljs-title, :root:not([data-theme]) .hljs-section, :root:not([data-theme]) .hljs-name { color: #79c0ff; }
    :root:not([data-theme]) .hljs-number { color: #ffa657; }
  }
  :root[data-theme="dark"] .hljs-keyword, :root[data-theme="dark"] .hljs-built_in, :root[data-theme="dark"] .hljs-literal { color: #d2a8ff; }
  :root[data-theme="dark"] .hljs-string, :root[data-theme="dark"] .hljs-attr { color: #7ee787; }
  :root[data-theme="dark"] .hljs-title, :root[data-theme="dark"] .hljs-section, :root[data-theme="dark"] .hljs-name { color: #79c0ff; }
  :root[data-theme="dark"] .hljs-number { color: #ffa657; }
  /* ---- mermaid diagrams ----
     Rendered client-side by the self-hosted renderer into an <svg> (themed from the
     live design tokens). Before the script runs (or with JS off) the raw diagram
     source stays hidden so authors never see DSL text flash. The container is
     theme-neutral so the on-brand svg fill carries the color. */
  .doc .mermaid {
    margin: 1.25rem 0; padding: 1rem; overflow-x: auto;
    background: var(--surface-sunken); border: 1px solid var(--border); border-radius: .6rem;
    text-align: center; color: transparent;
  }
  .doc .mermaid[data-processed="true"] { color: var(--fg); }
  .doc .mermaid:not([data-processed="true"]) { font-size: 0; line-height: 0; min-height: 2rem; }
  .doc .mermaid svg { max-width: 100%; height: auto; font-size: 1rem; }
`;

function renderToc(currentPath: string): string {
  const sections = DOC_NAV.map((s) => {
    const items = s.pages
      .map((p) => {
        const current = p.path === currentPath ? ' aria-current="page"' : "";
        return `<li><a href="${href(p.path)}"${current}>${escapeHtml(p.title)}</a></li>`;
      })
      .join("");
    return `<h2>${escapeHtml(s.section)}</h2><ul>${items}</ul>`;
  }).join("");
  return `<nav class="toc" aria-label="Documentation">${sections}</nav>`;
}

function renderPrevNext(currentPath: string): string {
  const i = FLAT.findIndex((p) => p.path === currentPath);
  if (i === -1) return "";
  const prev = i > 0 ? FLAT[i - 1] : null;
  const next = i < FLAT.length - 1 ? FLAT[i + 1] : null;
  const left = prev
    ? `<a href="${href(prev.path)}">← ${escapeHtml(prev.title)}</a>`
    : "<span></span>";
  const right = next
    ? `<a href="${href(next.path)}">${escapeHtml(next.title)} →</a>`
    : "<span></span>";
  return `<div class="prevnext">${left}${right}</div>`;
}

/** A trimmed one-line summary for meta description / social card. */
function summarize(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157).trimEnd()}…` : flat;
}

/** SEO + Open Graph + Twitter tags via the shared {@link ogMeta} builder, so a
 *  doc page unfurls identically to the landing + legal pages. `path` is the raw
 *  doc path; `href` maps it to the public `/docs/...` URL for canonical + og:url. */
function socialMeta(path: string, title: string, description: string, origin: string): string {
  return ogMeta({ origin, path: href(path), title, description });
}

/** Render the full HTML for a doc page, or null if the path is unknown.
 *  `origin` (config.baseUrl) makes the social-card URLs absolute. `skin` is the
 *  effective instance design skin (resolved per-request, default editorial), stamped
 *  on <html> via the shared helper exactly like the landing page. Pages with a
 *  ```mermaid block lazily load the self-hosted /docs/mermaid.js renderer. */
export function renderDocPage(
  path: string,
  origin = "",
  skin: SkinName = "editorial",
): string | null {
  const page = byPath.get(path);
  if (!page) return null;
  // The precompiled sanitizer emits plain <table> tags. Keep native table layout
  // inside a separate scroll region so narrow screens cannot crush its columns.
  const content = page.html
    .replaceAll(
      "<table>",
      '<div class="doc-table" role="region" aria-label="Scrollable table" tabindex="0"><table>',
    )
    .replaceAll("</table>", "</table></div>");
  const title = `${escapeHtml(page.title)} · canvas-drop docs`;
  const description = summarize(page.text) || "Documentation for canvas-drop.";
  // Only ship the (large) mermaid bundle on pages that actually contain a diagram.
  const hasMermaid = page.html.includes('class="mermaid"');
  const mermaidSrc = MERMAID_BUNDLE_VERSION
    ? `/docs/mermaid.js?v=${MERMAID_BUNDLE_VERSION}`
    : "/docs/mermaid.js";
  const mermaidScript = hasMermaid ? `\n  <script src="${mermaidSrc}" defer></script>` : "";
  return `<!doctype html>
${skinnedHtmlTag(skin)}
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${socialMeta(path, `${page.title} · canvas-drop docs`, description, origin)}
${FAVICON_LINKS}
${SITE_THEME_SCRIPT}
<style>
${DOCS_STYLES}
</style>
</head>
<body>
  ${siteHeader({ section: "docs" })}
  <div class="layout">
    <details class="docs-navigation" id="docs-navigation" open>
      <summary>Browse documentation</summary>
      <aside class="sidebar">
      <div class="search">
        <input type="search" id="docs-search" placeholder="Search docs…" autocomplete="off" aria-label="Search documentation">
        <div class="search-results" id="docs-search-results" role="region" aria-label="Search results"></div>
      </div>
      ${renderToc(path)}
      </aside>
    </details>
    <main class="content" id="main-content" tabindex="-1">
      <article class="doc">
        ${content}
      </article>
      ${renderPrevNext(path)}
    </main>
  </div>
  ${siteFooter(path === "" ? "/docs" : undefined)}
  <script src="/docs/nav.js?v=${NAV_VERSION}"></script>
  <script src="/docs/search.js?v=${SEARCH_VERSION}"></script>${mermaidScript}
</body>
</html>`;
}

/** True if a doc page exists at this path (for routing). */
export function hasDocPage(path: string): boolean {
  return byPath.has(path);
}

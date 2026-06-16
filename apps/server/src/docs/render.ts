import {
  DARK_TOKENS,
  escapeHtml,
  LIGHT_TOKENS,
  SYSTEM_PAGE_BRAND_INLINE,
  SYSTEM_PAGE_STYLES,
} from "../http/error-pages.js";
import { ogMeta } from "../http/social-meta.js";
import { DOC_NAV, DOC_PAGES, type DocPage } from "./generated-content.js";

/**
 * Renders the public docs site. Reuses the shared system-page token palette
 * (`SYSTEM_PAGE_STYLES`) and brand mark, then layers a multi-page docs shell on
 * top: a left nav, a content column, a search box, and prev/next. The mobile nav
 * is an off-canvas drawer driven by a pure-CSS checkbox so it works with no JS;
 * the search box is hidden until the served `/docs/search.js` marks the document
 * as JS-capable. Content is precompiled, sanitized HTML from generated-content.ts.
 */

const byPath = new Map<string, DocPage>(DOC_PAGES.map((p) => [p.path, p]));

/** Flat, ordered list of pages (nav order) for prev/next. */
const FLAT = DOC_NAV.flatMap((s) => s.pages);

function href(path: string): string {
  return path === "" ? "/docs" : `/docs/${path}`;
}

const DOCS_STYLES = `${SYSTEM_PAGE_STYLES}
  /* ---- manual theme override (data-theme) ----
     SYSTEM_PAGE_STYLES themes only via prefers-color-scheme. The docs add a
     switch that sets the same data-theme attribute + canvas-drop-theme key the
     dashboard uses, so a stored choice carries across. These selectors
     (\`:root[data-theme]\`) outrank the media query, so an explicit light choice
     forces light even on a dark OS, and vice versa. */
  :root[data-theme="dark"] {
${DARK_TOKENS}
  }
  :root[data-theme="light"] {
${LIGHT_TOKENS}
  }
  /* ---- theme switch (mirrors the dashboard's segmented control) ---- */
  .theme-switch {
    margin: 0 0 0 auto; padding: .125rem; border: 1px solid var(--border); border-radius: .5rem;
    background: var(--surface-sunken); display: grid; grid-auto-flow: column; gap: 0;
  }
  .theme-switch button {
    display: grid; place-items: center; width: 1.85rem; height: 1.85rem;
    border: 0; border-radius: .375rem; background: none; color: var(--muted);
    cursor: pointer; transition: color .1s ease, background .1s ease;
  }
  .theme-switch button:hover { color: var(--fg); }
  .theme-switch button[aria-pressed="true"] {
    background: var(--surface); color: var(--fg);
    box-shadow: 0 1px 3px hsl(var(--shadow-color) / 0.14);
  }
  .theme-switch button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .theme-switch svg { width: 1rem; height: 1rem; }
  /* ---- docs shell (overrides the centered card layout) ---- */
  body { display: block; place-items: initial; padding: 0; background: var(--canvas); min-height: 100dvh; }
  .topbar {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: .75rem;
    padding: .55rem clamp(1rem, 3vw, 1.5rem);
    border-bottom: 1px solid var(--border);
    /* Translucent + blurred, matching the landing header. Theme-aware via the
       surface token, so it reads correctly in both light and dark. */
    background: color-mix(in oklab, var(--surface-raised) 82%, transparent);
    backdrop-filter: blur(12px) saturate(1.4);
  }
  .topbar .brand { padding: 0; border: 0; background: none; }
  .topbar .to-app {
    display: inline-flex; align-items: center; gap: .35rem;
    font-size: .8125rem; font-weight: 600; line-height: 1;
    color: var(--accent-fg); background: var(--accent);
    text-decoration: none; padding: .45rem .8rem; border-radius: .5rem;
    transition: background .15s ease;
  }
  .topbar .to-app:hover { background: var(--accent-hover); }
  .topbar .to-app .arrow { transition: transform .15s ease; }
  .topbar .to-app:hover .arrow { transform: translateX(2px); }
  .nav-burger {
    display: none; cursor: pointer; user-select: none;
    font-size: 1.25rem; line-height: 1; padding: .25rem .5rem;
    border: 1px solid var(--border); border-radius: .5rem; color: var(--fg);
  }
  .nav-toggle { position: absolute; opacity: 0; pointer-events: none; }
  .layout { display: grid; grid-template-columns: 16rem minmax(0, 1fr); gap: 0; max-width: 72rem; margin: 0 auto; }
  .sidebar {
    align-self: start; position: sticky; top: 3.1rem;
    max-height: calc(100dvh - 3.1rem); overflow-y: auto;
    padding: 1.25rem 1rem; border-right: 1px solid var(--border);
  }
  .search { display: none; margin-bottom: 1rem; position: relative; }
  .has-js .search { display: block; }
  .search input {
    width: 100%; padding: .5rem .65rem; font: inherit; font-size: .875rem;
    color: var(--fg); background: var(--surface); border: 1px solid var(--border); border-radius: .5rem;
  }
  .search input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .search-results {
    position: absolute; left: 0; right: 0; margin-top: .25rem; z-index: 30;
    background: var(--surface-raised); border: 1px solid var(--border); border-radius: .5rem;
    box-shadow: var(--shadow-panel); overflow: hidden;
  }
  .search-results:empty { display: none; }
  .search-results a, .search-results .empty {
    display: block; padding: .5rem .65rem; font-size: .8125rem; color: var(--fg); text-decoration: none;
  }
  .search-results a:hover { background: var(--surface-sunken); }
  .search-results .empty { color: var(--subtle); }
  nav.toc h2 { margin: 1rem 0 .35rem; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: var(--subtle); }
  nav.toc ul { list-style: none; margin: 0 0 .5rem; padding: 0; }
  nav.toc a {
    display: block; padding: .25rem .5rem; border-radius: .375rem;
    color: var(--muted); text-decoration: none; font-size: .875rem;
  }
  nav.toc a:hover { background: var(--surface-sunken); color: var(--fg); }
  nav.toc a[aria-current="page"] { background: var(--accent-subtle); color: var(--accent); font-weight: 600; }
  /* <main> inherits a centered card (border/radius/shadow/42rem width) from the
     shared SYSTEM_PAGE_STYLES. Docs want an open content column, not a card — reset
     those so the content doesn't collide with the sidebar + topbar. */
  .content {
    min-width: 0; width: auto; max-width: none;
    border: 0; border-radius: 0; background: none; box-shadow: none; overflow: visible;
    padding: clamp(2rem, 4vw, 3.5rem) clamp(1.5rem, 4vw, 2.75rem);
  }
  .doc { max-width: 46rem; }
  .doc h1 { margin: 0 0 1rem; font-size: clamp(1.7rem, 5vw, 2.3rem); line-height: 1.1; letter-spacing: -.02em; }
  /* Lede treatment: the page's opening heading reads larger, and the intro
     paragraph that follows it is set as a muted lede with a hairline rule, so each
     doc opens deliberately instead of dropping straight into body copy. */
  .doc > h1:first-child { font-size: clamp(2rem, 5vw, 2.75rem); letter-spacing: -.028em; margin-bottom: .85rem; }
  .doc > h1:first-child + p { font-size: 1.075rem; line-height: 1.65; color: var(--muted); padding-bottom: 1.4rem; margin-bottom: 1.6rem; border-bottom: 1px solid var(--border); }
  .doc h2 { margin: 2rem 0 .6rem; font-size: 1.25rem; letter-spacing: -.01em; scroll-margin-top: 4rem; }
  .doc h3 { margin: 1.5rem 0 .5rem; font-size: 1.05rem; scroll-margin-top: 4rem; }
  .doc p, .doc li { color: var(--muted); }
  .doc a { color: var(--accent); text-decoration: none; }
  .doc a:hover { text-decoration: underline; }
  .doc code { font-size: .85em; background: var(--surface-sunken); padding: .1em .35em; border-radius: .3rem; }
  .doc pre { margin: 1rem 0; padding: 1rem; overflow-x: auto; background: var(--surface-sunken); border: 1px solid var(--border); border-radius: .6rem; }
  .doc pre code { background: none; padding: 0; font-size: .8125rem; line-height: 1.5; }
  .doc table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .875rem; }
  .doc th, .doc td { text-align: left; padding: .45rem .65rem; border-bottom: 1px solid var(--border); }
  .doc th { color: var(--fg); font-weight: 600; }
  .doc blockquote { margin: 1rem 0; padding: .75rem 1rem; border-left: 3px solid var(--accent); background: var(--accent-subtle); border-radius: 0 .5rem .5rem 0; }
  .doc blockquote p { margin: .25rem 0; color: var(--fg); }
  /* minimal hljs token colors (token classes emitted at build time) */
  .hljs-keyword, .hljs-built_in, .hljs-literal { color: #8250df; }
  .hljs-string, .hljs-attr { color: #0a7d28; }
  .hljs-comment { color: var(--subtle); font-style: italic; }
  .hljs-title, .hljs-section, .hljs-name { color: #1f6feb; }
  .hljs-number { color: #b5500a; }
  .prevnext { display: flex; justify-content: space-between; gap: 1rem; margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); }
  .prevnext a { color: var(--accent); text-decoration: none; font-size: .875rem; }
  @media (max-width: 48rem) {
    .nav-burger { display: inline-flex; }
    .layout { grid-template-columns: 1fr; }
    .sidebar {
      position: fixed; top: 0; left: 0; bottom: 0; width: 17rem; z-index: 40;
      background: var(--surface-raised); border-right: 1px solid var(--border);
      transform: translateX(-100%); transition: transform .2s ease; max-height: none;
    }
    .nav-toggle:checked ~ .layout .sidebar { transform: none; }
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
  :root[data-theme="dark"] .hljs-number { color: #ffa657; }`;

/** The topbar theme switch (System / Light / Dark), mirroring the dashboard's
 *  segmented control. Static markup; /docs/theme.js wires clicks + aria-pressed
 *  and applies the persisted choice (shared `canvas-drop-theme` key) before paint. */
const THEME_SWITCH = `<fieldset class="theme-switch" data-theme-switch aria-label="Theme">
        <button type="button" data-theme-choice="system" aria-pressed="false" aria-label="Use system theme" title="Theme: System">
          <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208 40H48a24 24 0 0 0-24 24v112a24 24 0 0 0 24 24h53.33l-5.34 32H80a8 8 0 0 0 0 16h96a8 8 0 0 0 0-16h-15.99l-5.34-32H208a24 24 0 0 0 24-24V64a24 24 0 0 0-24-24Zm8 136a8 8 0 0 1-8 8H48a8 8 0 0 1-8-8V64a8 8 0 0 1 8-8h160a8 8 0 0 1 8 8Z"/></svg>
        </button>
        <button type="button" data-theme-choice="light" aria-pressed="false" aria-label="Use light theme" title="Theme: Light">
          <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M120 40V16a8 8 0 0 1 16 0v24a8 8 0 0 1-16 0Zm72 88a64 64 0 1 1-64-64 64.07 64.07 0 0 1 64 64Zm-16 0a48 48 0 1 0-48 48 48.05 48.05 0 0 0 48-48ZM58.34 69.66a8 8 0 0 0 11.32-11.32l-16-16a8 8 0 0 0-11.32 11.32Zm0 116.68-16 16a8 8 0 0 0 11.32 11.32l16-16a8 8 0 0 0-11.32-11.32ZM192 72a8 8 0 0 0 5.66-2.34l16-16a8 8 0 0 0-11.32-11.32l-16 16A8 8 0 0 0 192 72Zm5.66 114.34a8 8 0 0 0-11.32 11.32l16 16a8 8 0 0 0 11.32-11.32ZM48 128a8 8 0 0 0-8-8H16a8 8 0 0 0 0 16h24a8 8 0 0 0 8-8Zm80 80a8 8 0 0 0-8 8v24a8 8 0 0 0 16 0v-24a8 8 0 0 0-8-8Zm112-88h-24a8 8 0 0 0 0 16h24a8 8 0 0 0 0-16Z"/></svg>
        </button>
        <button type="button" data-theme-choice="dark" aria-pressed="false" aria-label="Use dark theme" title="Theme: Dark">
          <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M233.54 142.23a8 8 0 0 0-8-2 88.08 88.08 0 0 1-109.8-109.8 8 8 0 0 0-10-10 104.84 104.84 0 0 0-52.91 37A104 104 0 0 0 136 224a103.09 103.09 0 0 0 62.52-20.88 104.84 104.84 0 0 0 37-52.91 8 8 0 0 0-1.98-7.98Zm-44.64 48.11A88 88 0 0 1 65.66 67.11a89 89 0 0 1 31.4-26A106 106 0 0 0 96 56a104.11 104.11 0 0 0 104 104 106 106 0 0 0 14.92-1.06 89 89 0 0 1-26.02 31.4Z"/></svg>
        </button>
      </fieldset>`;

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
 *  `origin` (config.baseUrl) makes the social-card URLs absolute. */
export function renderDocPage(path: string, origin = ""): string | null {
  const page = byPath.get(path);
  if (!page) return null;
  const title = `${escapeHtml(page.title)} · canvas-drop docs`;
  const description = summarize(page.text) || "Documentation for canvas-drop.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${socialMeta(path, `${page.title} · canvas-drop docs`, description, origin)}
<script src="/docs/theme.js"></script>
<style>
${DOCS_STYLES}
</style>
</head>
<body>
  <input type="checkbox" id="nav-toggle" class="nav-toggle">
  <header class="topbar">
    <label for="nav-toggle" class="nav-burger" aria-label="Toggle navigation">☰</label>
    <a href="/docs" style="text-decoration:none;color:inherit">${SYSTEM_PAGE_BRAND_INLINE}</a>
    ${THEME_SWITCH}
    <a href="/" class="to-app">Open app <span class="arrow" aria-hidden="true">→</span></a>
  </header>
  <div class="layout">
    <aside class="sidebar">
      <div class="search">
        <input type="search" id="docs-search" placeholder="Search docs…" autocomplete="off" aria-label="Search documentation">
        <div class="search-results" id="docs-search-results" role="listbox"></div>
      </div>
      ${renderToc(path)}
    </aside>
    <main class="content">
      <article class="doc">
        ${page.html}
      </article>
      ${renderPrevNext(path)}
    </main>
  </div>
  <script src="/docs/search.js"></script>
</body>
</html>`;
}

/** True if a doc page exists at this path (for routing). */
export function hasDocPage(path: string): boolean {
  return byPath.has(path);
}

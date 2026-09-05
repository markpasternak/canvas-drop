import { createHash } from "node:crypto";
import { BRAND, rampCssVars } from "@canvas-drop/shared";
import { THEME_CLIENT_JS } from "../docs/theme.client.js";
import { BRAND_MARK } from "./brand.js";
import { escapeHtml } from "./error-pages.js";
import { skinStyleCss } from "./skin-html.js";

/** Shared chrome for public reading surfaces; independent of error/gate layouts. */
export const SITE_THEME_SCRIPT = `<script src="/docs/theme.js?v=${createHash("sha256").update(THEME_CLIENT_JS).digest("hex").slice(0, 8)}"></script>`;

export const SITE_STYLES = `
@font-face { font-family: "Newsreader Variable"; font-style: normal; font-display: swap; font-weight: 200 800; src: url(/fonts/newsreader-latin-wght-normal.woff2) format("woff2-variations"); }
@font-face { font-family: "Newsreader Variable"; font-style: italic; font-display: swap; font-weight: 200 800; src: url(/fonts/newsreader-latin-standard-italic.woff2) format("woff2-variations"); }
@font-face { font-family: "Geist Variable"; font-style: normal; font-display: swap; font-weight: 100 900; src: url(/fonts/geist-latin-wght-normal.woff2) format("woff2-variations"); }
@font-face { font-family: "Geist Mono Variable"; font-style: normal; font-display: swap; font-weight: 100 900; src: url(/fonts/geist-mono-latin-wght-normal.woff2) format("woff2-variations"); }
:root {
${rampCssVars("light")}
  color-scheme: light; --font-serif: ${BRAND.fontSerif}; --font-display: var(--font-serif);
  --display-weight: 450; --display-tracking: -.025em; --radius-scale: 1; --site-header-height: 5rem;
}
@media (prefers-color-scheme: dark) { :root {
${rampCssVars("dark")}
  color-scheme: dark;
} }
:root[data-theme="light"] {
${rampCssVars("light")}
  color-scheme: light;
}
:root[data-theme="dark"] {
${rampCssVars("dark")}
  color-scheme: dark;
}
${skinStyleCss({ darkToggle: true })}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; scroll-padding-top: calc(var(--site-header-height) + 1rem); }
body { margin: 0; min-height: 100dvh; background: var(--canvas); color: var(--fg); font: 16px/1.65 ${BRAND.fontSans}; -webkit-font-smoothing: antialiased; }
button, input { font: inherit; }
code, pre { font-family: ${BRAND.fontMono}; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.site-skip { position: fixed; top: .5rem; left: 1rem; z-index: 50; padding: .65rem 1rem; background: var(--fg); color: var(--canvas); border-radius: .5rem; transform: translateY(-200%); }
.site-skip:focus { transform: none; }
.site-width { width: min(100%, 78rem); margin-inline: auto; padding-inline: clamp(1.25rem, 5vw, 3.5rem); }
.site-header { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--border); background: var(--canvas); }
.site-header-inner { min-height: var(--site-header-height); display: flex; align-items: center; gap: 1.5rem; }
.site-brand { display: inline-flex; align-items: center; gap: .625rem; flex-shrink: 0; color: var(--fg); text-decoration: none; font-size: .9375rem; font-weight: 650; letter-spacing: -.025em; line-height: 1; }
.site-brand:hover { color: var(--fg); text-decoration: none; }
.site-logo { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; border-radius: .625rem; background: var(--accent); --logo-frame: var(--accent-fg); --logo-drop: var(--accent-fg); }
.site-logo .mark { width: 1.25rem; height: 1.25rem; }
.site-header .site-brand { margin-right: auto; }
.site-nav, .site-links { display: flex; align-items: center; gap: 1.25rem; }
.site-nav a, .site-links a { display: inline-flex; align-items: center; min-height: 44px; color: var(--muted); font-size: .875rem; text-decoration: none; text-underline-offset: .3em; }
.site-nav a:hover, .site-links a:hover { color: var(--fg); text-decoration: underline; }
.site-nav a[aria-current], .site-links a[aria-current] { color: var(--fg); font-weight: 650; text-decoration: underline; text-decoration-color: var(--accent); }
.site-action { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: .6rem .9rem; border: 1px solid var(--border-strong); border-radius: calc(.5rem * var(--radius-scale)); font-size: .875rem; font-weight: 550; color: var(--fg); text-decoration: none; white-space: nowrap; }
.site-action:hover { background: var(--surface-sunken); color: var(--fg); text-decoration: none; }
.theme-switch { display: none; margin: 0; padding: 2px; border: 1px solid var(--border); border-radius: .625rem; min-width: 0; background: var(--surface-sunken); }
.theme-ready .theme-switch { display: flex; }
.theme-switch button { display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: .45rem; background: none; color: var(--muted); cursor: pointer; }
.theme-switch button:hover { color: var(--fg); }
.theme-switch button[aria-pressed="true"] { background: var(--surface); color: var(--fg); box-shadow: 0 1px 3px #0001; }
.theme-switch svg { width: 1rem; height: 1rem; }
.site-footer { border-top: 1px solid var(--border); padding-block: 2rem; }
.site-footer-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem 2rem; flex-wrap: wrap; }
.site-links { flex-wrap: wrap; }
.site-colophon { margin: 1.25rem 0 0; color: var(--muted); font-size: .8125rem; max-width: 70ch; }
@media (max-width: 42rem) {
  :root { --site-header-height: 7.75rem; }
  .site-header-inner { min-height: 0; padding-block: .75rem; gap: .5rem 1rem; flex-wrap: wrap; }
  .site-nav { order: 3; width: 100%; min-height: 44px; }
  .site-nav .theme-switch { margin-left: auto; }
  .theme-switch button { width: 44px; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
`;

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

export function siteBrand(): string {
  return `<a class="site-brand" href="/" aria-label="${escapeHtml(BRAND.name)} home"><span class="site-logo">${BRAND_MARK}</span><span>${escapeHtml(BRAND.name)}</span></a>`;
}

export function siteHeader(
  opts: { section?: "docs"; action?: { href: string; label: string } } = {},
): string {
  const action = opts.action ?? { href: "/", label: "Open app" };
  return `<a class="site-skip" href="#main-content">Skip to content</a>
<header class="site-header"><div class="site-width site-header-inner">
  ${siteBrand()}
  <nav class="site-nav" aria-label="Primary">
    <a href="/docs"${opts.section === "docs" ? ' aria-current="location"' : ""}>Docs</a>
    <a href="${escapeHtml(BRAND.githubUrl)}" target="_blank" rel="noopener noreferrer">GitHub</a>
    ${THEME_SWITCH}
  </nav>
  <a class="site-action" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>
</div></header>`;
}

export function siteFooter(current?: "/docs" | "/privacy" | "/terms"): string {
  const links = [
    ["/docs", "Docs"],
    [BRAND.githubUrl, "GitHub"],
    ["/terms", "Terms"],
    ["/privacy", "Privacy"],
  ] as const;
  return `<footer class="site-footer"><div class="site-width">
    <div class="site-footer-row">${siteBrand()}<nav class="site-links" aria-label="Footer">${links.map(([url, label]) => `<a href="${escapeHtml(url)}"${url === current ? ' aria-current="page"' : ""}${url === BRAND.githubUrl ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`).join("")}</nav></div>
    <p class="site-colophon">Small web tools, built by your team. Open source under the MIT license. Inspired by Shopify's Quick; not affiliated with Shopify.</p>
  </div></footer>`;
}

// Source for the self-hosted docs Mermaid bundle, compiled by `pnpm docs:mermaid`
// (esbuild → IIFE) into apps/server/src/docs/mermaid.bundle.ts as a committed
// string constant the server serves verbatim at GET /docs/mermaid.js. Bundling
// it (rather than pulling mermaid from a CDN) keeps the docs CSP at
// `script-src 'self'` and honors the no-phone-home rule — mermaid is large, so it
// is loaded deferred and only initialized when a diagram is present on the page.
//
// Security posture: mermaid runs with `securityLevel: 'strict'` (its built-in
// DOMPurify pass sanitizes diagram-derived markup and blocks click/script
// directives) and `startOnLoad: false` — we call run() ourselves, once, scoped to
// the `.mermaid` blocks that survived the server-side sanitize-html pass. Theming
// is driven entirely by `themeVariables` wired to the page's CSS custom properties
// (the brand/skin tokens), re-read on each theme/skin change so a diagram recolors
// with the active skin AND light/dark mode.

import mermaid from "mermaid";

/** Read a CSS custom property off :root, trimmed, with a fallback. */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Build mermaid themeVariables from the live design tokens (skin + theme aware). */
function themeVariables() {
  const accent = cssVar("--accent", "#0b7");
  const accentSubtle = cssVar("--accent-subtle", "#dfe");
  const surface = cssVar("--surface", "#fff");
  const surfaceRaised = cssVar("--surface-raised", surface);
  const border = cssVar("--border", "#ccc");
  const fg = cssVar("--fg", "#111");
  const muted = cssVar("--muted", fg);
  return {
    // Core palette — nodes wear the surface, borders the brand accent, text the fg.
    background: surface,
    primaryColor: surfaceRaised,
    primaryBorderColor: accent,
    primaryTextColor: fg,
    secondaryColor: accentSubtle,
    secondaryBorderColor: border,
    secondaryTextColor: fg,
    tertiaryColor: surface,
    tertiaryBorderColor: border,
    tertiaryTextColor: fg,
    // Lines / edges / labels.
    lineColor: muted,
    textColor: fg,
    mainBkg: surfaceRaised,
    nodeBorder: accent,
    clusterBkg: cssVar("--surface-sunken", surface),
    clusterBorder: border,
    edgeLabelBackground: surface,
    // Notes + actor styling pick up the brand accent so sequence diagrams stay on-brand.
    noteBkgColor: accentSubtle,
    noteBorderColor: accent,
    noteTextColor: fg,
    actorBkg: surfaceRaised,
    actorBorder: accent,
    actorTextColor: fg,
    activationBkgColor: accentSubtle,
    labelBoxBkgColor: surfaceRaised,
    labelBoxBorderColor: accent,
    labelTextColor: fg,
    fontFamily: cssVar("--font-sans", "ui-sans-serif, system-ui, sans-serif"),
  };
}

function configure() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: themeVariables(),
    flowchart: { curve: "basis", useMaxWidth: true },
    sequence: { useMaxWidth: true },
  });
}

// Each .mermaid block keeps its raw source in a data-attribute the first time we
// see it, so re-rendering on a theme/skin change re-runs from source (mermaid
// replaces the element's content with an <svg> on the first pass).
function stashSources(blocks) {
  blocks.forEach((el) => {
    if (!el.dataset.mermaidSrc) el.dataset.mermaidSrc = el.textContent;
    else {
      el.removeAttribute("data-processed");
      el.textContent = el.dataset.mermaidSrc;
    }
  });
}

let renderToken = 0;
async function render() {
  const blocks = Array.from(document.querySelectorAll(".mermaid"));
  if (blocks.length === 0) return;
  const token = ++renderToken;
  stashSources(blocks);
  configure();
  try {
    await mermaid.run({ nodes: blocks });
  } catch (err) {
    // A malformed diagram must never break the page; mermaid already inlines a
    // parse-error glyph, so just log for authors.
    if (token === renderToken) console.error("[docs] mermaid render failed:", err);
  }
}

// Re-theme when the docs theme switch flips data-theme on <html>, or when the
// instance skin changes data-skin (both are attribute mutations on the root).
function watchTokens() {
  let raf = 0;
  const obs = new MutationObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  });
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-skin"],
  });
}

function start() {
  render();
  watchTokens();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

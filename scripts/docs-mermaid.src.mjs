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

// The design tokens are authored in `oklch()`, which mermaid's color library
// (khroma) cannot parse — feeding it an oklch string throws "Unsupported color
// format" out of mermaid.initialize and aborts the (re-)render. We must hand it a
// plain rgb string. The catch: current Chrome (149+) preserves the authored
// `oklch()` color space through BOTH getComputedStyle().color AND a canvas
// fillStyle setter→getter — neither serializes down to sRGB. The one thing that
// forces real sRGB bytes is actually RASTERIZING: paint a 1×1 pixel and read it
// back with getImageData. A hidden probe first resolves var()/inheritance to a
// concrete color string for the paint.
function makeColorResolver() {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.documentElement.appendChild(probe);
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const resolve = (name, fallback) => {
    const raw = cssVar(name, fallback);
    probe.style.color = "";
    probe.style.color = raw; // invalid values are ignored, leaving the cleared base
    const resolved = getComputedStyle(probe).color || raw;
    try {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000"; // sentinel so an unpaintable value can't leak a prior color
      ctx.fillStyle = resolved;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 255
        ? `rgb(${r}, ${g}, ${b})`
        : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    } catch {
      return fallback;
    }
  };
  resolve.done = () => probe.remove();
  return resolve;
}

/** Build mermaid themeVariables from the live design tokens (skin + theme aware). */
function themeVariables() {
  const color = makeColorResolver();
  const accent = color("--accent", "#0b7");
  const accentSubtle = color("--accent-subtle", "#dfe");
  const surface = color("--surface", "#fff");
  const surfaceRaised = color("--surface-raised", "#fff");
  const border = color("--border", "#ccc");
  const fg = color("--fg", "#111");
  const muted = color("--muted", "#666");
  const surfaceSunken = color("--surface-sunken", "#f0f0f0");
  color.done();
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
    clusterBkg: surfaceSunken,
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
  const base = {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    flowchart: { curve: "basis", useMaxWidth: true },
    sequence: { useMaxWidth: true },
  };
  // Theming must never blank a diagram: if a token can't be turned into a color
  // mermaid accepts, fall back to mermaid's stock theme rather than throwing out
  // of initialize() and aborting the (re-)render.
  try {
    mermaid.initialize({ ...base, themeVariables: themeVariables() });
  } catch (err) {
    console.error("[docs] mermaid theming failed; using default theme:", err);
    mermaid.initialize(base);
  }
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

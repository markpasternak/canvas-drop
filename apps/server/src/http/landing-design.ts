/** Existing gallery screenshot uses seeded examples, never production content. */
export const LANDING_GALLERY = `
<section class="gallery-preview wrap" aria-label="Explore the gallery">
  <div class="gallery-caption"><div><h2>A home for what your team makes.</h2><p>Dashboards, calculators, roadmaps, and the next useful idea.</p></div><a class="btn btn-outline" href="/gallery">Explore Gallery <span aria-hidden="true">↗</span></a></div>
  <a class="gallery-shot" href="/gallery" aria-label="Open Gallery"><img src="/docs/assets/landing-gallery.webp" width="1440" height="900" alt="Canvas Drop Gallery with sample canvases: a revenue dashboard, sprint board, pricing calculator, roadmap, and more." decoding="async" fetchpriority="high"></a>
  <p class="gallery-note">Example canvases in the Editorial skin. Sign in to explore your instance’s gallery.</p>
</section>`;

/** Layout only: colors, type, and corner scale resolve from the shared brand/skin. */
export const LANDING_LAYOUT = `
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; background: var(--canvas); color: var(--fg); font: 16px/1.6 "Geist Variable", ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
button { font: inherit; }
.wrap { width: min(100%, 78rem); margin-inline: auto; padding-inline: clamp(1.25rem, 5vw, 3.5rem); }
.mono { font-family: "Geist Mono Variable", ui-monospace, monospace; }
.spacer { flex: 1; }
.nav { display: flex; align-items: center; gap: 1rem; min-height: 5.5rem; }
.brand { display: inline-flex; align-items: center; gap: .6rem; font-weight: 650; letter-spacing: -.025em; --logo-frame: var(--fg); --logo-drop: var(--accent); }
.brand .mark { width: 1.65rem; height: 1.65rem; }
.nav-links, .foot-links { display: flex; align-items: center; gap: 1.5rem; font-size: .875rem; }
.link, .foot-links a { color: var(--muted); }
a:hover { color: var(--accent); }
.btn { display: inline-flex; justify-content: center; align-items: center; gap: .6rem; padding: .72rem 1rem; min-height: 44px; border: 1px solid var(--border); border-radius: calc(.5rem * var(--radius-scale)); font-size: .875rem; font-weight: 550; cursor: pointer; transition: background .16s ease, border-color .16s ease; }
.btn svg { width: 1.1em; height: 1.1em; }
.btn-primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
.btn-primary:hover { background: var(--accent-hover); color: var(--accent-fg); }
.btn-ghost, .btn-outline { background: transparent; color: var(--fg); }
.btn-ghost:hover, .btn-outline:hover { background: var(--surface-sunken); border-color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.hero-inner { display: grid; grid-template-columns: .9fr 1.1fr; gap: clamp(2rem, 5vw, 5rem); align-items: end; padding-block: clamp(2rem, 6vw, 4.5rem); }
.eyebrow, .kicker { display: block; color: var(--muted); font-size: .8rem; margin: 0 0 1.25rem; }
h1 { font-family: var(--font-display); font-size: clamp(3.1rem, 5.5vw, 5rem); font-weight: var(--display-weight, 450); font-optical-sizing: auto; line-height: 1.02; letter-spacing: -.045em; margin: 0; }
h1 .accent { font-style: italic; color: var(--accent); }
.lede { font-size: 1.05rem; line-height: 1.65; max-width: 37ch; color: var(--muted); margin: 1.65rem 0; }
.cta-row { display: flex; flex-wrap: wrap; align-items: center; gap: .8rem; margin-top: 1.8rem; }
.cue { margin-top: 1.15rem; font-size: .8rem; color: var(--muted); }
.cue a, .s-sub a, .ladder-note a { text-decoration: underline; text-underline-offset: 3px; }
.gallery-preview { padding-bottom: clamp(3rem, 7vw, 6rem); }
.gallery-caption { display: flex; align-items: end; justify-content: space-between; gap: 1.5rem; margin-bottom: 1.5rem; }
.gallery-caption h2 { font-family: var(--font-display); font-weight: var(--display-weight, 450); font-size: clamp(1.5rem, 2.5vw, 2rem); letter-spacing: -.02em; line-height: 1.2; margin: 0; }
.gallery-caption p { font-size: .875rem; color: var(--muted); margin: .6rem 0 0; }
.gallery-caption .btn { flex-shrink: 0; }
.gallery-shot { display: block; overflow: hidden; border: 1px solid var(--border); border-radius: calc(.75rem * var(--radius-scale)); box-shadow: 0 16px 45px color-mix(in oklab, var(--fg) 7%, transparent); }
.gallery-shot img { display: block; width: 100%; height: auto; }
.gallery-note { margin: .8rem 0 0; color: var(--muted); font-size: .75rem; }
.section { padding-block: clamp(3.5rem, 7vw, 6rem); border-top: 1px solid var(--border); }
.section-tint { background: var(--surface-sunken); }
.s-head { font-family: var(--font-display); font-weight: var(--display-weight, 450); font-size: clamp(2rem, 3.5vw, 3.25rem); letter-spacing: -.025em; line-height: 1.1; max-width: 23ch; margin: 0; }
.s-sub { color: var(--muted); max-width: 65ch; margin: 1.25rem 0 0; font-size: .95rem; }
.values { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2.5rem; }
.num { color: var(--accent); font-size: .8rem; }
.value h3 { font-family: var(--font-display); font-weight: var(--display-weight, 450); font-size: 1.7rem; line-height: 1.2; margin: 1.2rem 0 .6rem; }
.value p { color: var(--muted); font-size: .875rem; margin: 0; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(2rem, 6vw, 6rem); }
.ladder { border-top: 1px solid var(--border); }
.rung { display: flex; gap: 1.2rem; padding: 1.2rem 0; border-bottom: 1px solid var(--border); }
.r-step { color: var(--muted); font-size: .8rem; }
.r-name { font-size: .95rem; font-weight: 550; }
.rung.feature .r-name { color: var(--accent); }
.r-tag, .tag { color: var(--muted); font-weight: 400; font-size: .65rem; margin-left: .5rem; }
.r-who, .ladder-note { color: var(--muted); font-size: .8rem; margin: .3rem 0 0; }
.ladder-note { margin-top: 1.5rem; }
.prims { display: grid; grid-template-columns: repeat(3, 1fr); column-gap: 2.5rem; margin-top: 2.5rem; }
.prim { position: relative; border-top: 1px solid var(--border); padding: 1.3rem 0 1.6rem 2rem; }
.ic { position: absolute; left: 0; top: 1.45rem; color: var(--accent); }
.ic svg { width: 1.15rem; height: 1.15rem; }
.prim h4 { font-size: .9rem; margin: 0 0 .5rem; font-weight: 550; }
.prim p { color: var(--muted); font-size: .8rem; margin: 0; }
.feats { margin-top: 2rem; }
.feat { border-top: 1px solid var(--border); padding: 1rem 0; }
.feat summary { cursor: pointer; font-size: .9rem; min-height: 24px; }
.feat p { font-size: .85rem; color: var(--muted); margin: .65rem 0 0; }
.trust { display: flex; flex-wrap: wrap; gap: 1rem 2rem; margin-top: 2rem; color: var(--muted); font-size: .8rem; }
footer { border-top: 1px solid var(--border); padding-block: 2rem; }
.foot { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; }
.colophon { color: var(--muted); font-size: .75rem; margin-top: 1.5rem; max-width: 80ch; }
@media (max-width: 760px) { .hero-inner, .split { grid-template-columns: 1fr; } .hero-inner { padding-top: 2rem; gap: .5rem; } h1 { font-size: clamp(3.3rem, 10vw, 4.6rem); } .lede { max-width: 45ch; } .gallery-caption { align-items: start; flex-direction: column; gap: 1rem; } .gallery-shot { overflow-x: auto; } .gallery-shot img { width: 900px; max-width: none; } .values { grid-template-columns: 1fr; gap: 2rem; } .value { display: grid; grid-template-columns: 2rem 1fr; column-gap: 1rem; } .value h3 { margin: 0 0 .5rem; } .value p { grid-column: 2; } .prims { grid-template-columns: repeat(2, 1fr); } .nav-links { gap: 1rem; } .nav .hide-sm { display: none; } }
@media (max-width: 420px) { .prims { grid-template-columns: 1fr; } .foot-links { gap: 1rem; flex-wrap: wrap; } }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { transition: none !important; } }
`;

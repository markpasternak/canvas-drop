/** Layout only: colors, type, and corner scale resolve from the shared brand/skin. */
export const LANDING_LAYOUT = `
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; scrollbar-color: var(--border-strong) var(--canvas); }
body { margin: 0; background: var(--canvas); color: var(--fg); font: 16px/1.6 "Geist Variable", ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
::selection { color: var(--accent-fg); background: var(--accent); }
a { color: inherit; text-decoration: none; text-underline-offset: .2em; }
button, select { font: inherit; }
.wrap { width: min(100%, 78rem); margin-inline: auto; padding-inline: clamp(1.25rem, 5vw, 3.5rem); }
a:hover { color: var(--accent); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.btn { display: inline-flex; justify-content: center; align-items: center; gap: .6rem; padding: .72rem 1rem; min-height: 44px; border: 1px solid var(--border); border-radius: calc(.5rem * var(--radius-scale)); font-size: .875rem; font-weight: 550; cursor: pointer; transition: background .16s ease, border-color .16s ease; }
.btn svg { width: 1.1em; height: 1.1em; flex-shrink: 0; }
.btn-primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
.btn-primary:hover { background: var(--accent-hover); color: var(--accent-fg); }
.btn-ghost, .btn-outline { background: transparent; color: var(--fg); }
.btn-ghost:hover, .btn-outline:hover { background: var(--surface-sunken); border-color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.hero-inner { display: grid; grid-template-columns: 1.15fr 1fr; gap: clamp(2rem, 4vw, 4rem); align-items: center; padding-block: clamp(2rem, 4vw, 3.5rem); }
h1 { font-family: var(--font-display); font-size: clamp(3rem, 4.5vw, 4.4rem); font-weight: var(--display-weight, 450); font-optical-sizing: auto; line-height: 1.06; letter-spacing: -.03em; margin: 0; text-wrap: balance; }
h1 .accent { font-style: italic; color: var(--accent); }
.lede { font-size: 1rem; line-height: 1.65; max-width: 49ch; color: var(--muted); margin: 0; }
.cta-row { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin-top: 1.4rem; }
.cue { margin: 1rem 0 0; font-size: .8rem; color: var(--muted); }
.cue a, .s-sub a, .ladder-note a { text-decoration: underline; }
.tour { padding-bottom: clamp(2.5rem, 5vw, 4.5rem); }
.tour-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem 2rem; padding-block: 1rem; border-top: 1px solid var(--border); }
.tour-heading h2 { font-family: var(--font-display); font-weight: var(--display-weight, 450); font-size: 1.5rem; line-height: 1.2; letter-spacing: -.015em; margin: 0; }
.viewport { overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: thin; }
.carousel.is-enhanced .viewport { overflow: hidden; scroll-snap-type: none; }
.embla-container { display: flex; }
.carousel.is-enhanced .embla-container { touch-action: pan-y pinch-zoom; }
.slide { display: grid; grid-template-columns: minmax(0, 16rem) minmax(0, 1fr); align-items: start; gap: clamp(1.5rem, 3vw, 2.5rem); flex: 0 0 100%; min-width: 0; margin: 0; scroll-snap-align: start; }
.shot { border: 1px solid var(--border); border-radius: calc(.75rem * var(--radius-scale)); overflow: hidden; background: var(--surface); }
.shot img { display: block; width: 100%; height: auto; aspect-ratio: 8 / 5; object-fit: contain; }
.tour-caption { min-width: 0; padding-top: 1rem; }
.tour-caption h3 { font-family: var(--font-display); font-weight: var(--display-weight, 450); font-size: clamp(1.65rem, 2.2vw, 2rem); line-height: 1.16; letter-spacing: -.02em; text-wrap: balance; margin: 0; }
.tour-caption p { font-size: .875rem; line-height: 1.65; color: var(--muted); margin: 1rem 0; }
.text-link { display: inline-flex; align-items: center; gap: .5rem; min-height: 44px; font-size: .8125rem; text-decoration: underline; }
.text-link svg { width: 1rem; height: 1rem; flex-shrink: 0; }
.tour-caption .text-link { padding-block: .5rem; }
.tour-controls, .tour-pagination { display: flex; align-items: center; gap: .6rem; }
.tour-controls { gap: 1.5rem; }
.tour-picker { display: flex; align-items: center; gap: .7rem; color: var(--muted); font-size: .8125rem; }
.tour-picker select { min-height: 44px; min-width: 12rem; max-width: 100%; padding: .55rem 2rem .55rem .75rem; border: 1px solid var(--border); border-radius: calc(.5rem * var(--radius-scale)); background: var(--surface); color: var(--fg); cursor: pointer; }
.tour-picker select:hover { border-color: var(--accent); }
.tour-topic { position: relative; min-width: 0; width: 13rem; color: var(--fg); }
.tour-topic-trigger { display: flex; align-items: center; justify-content: space-between; gap: .75rem; width: 100%; min-height: 44px; padding: .6rem .75rem; border: 1px solid var(--border-strong); border-radius: calc(.5rem * var(--radius-scale)); background: var(--surface); color: var(--fg); font-size: .8125rem; text-align: left; cursor: pointer; }
.tour-topic-trigger > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tour-topic-trigger > svg { width: 1rem; height: 1rem; flex-shrink: 0; color: var(--muted); }
.tour-topic-trigger:hover { background: var(--surface-sunken); }
.tour-topic-trigger[aria-expanded="true"] { border-color: var(--accent); }
.tour-topic-trigger[aria-expanded="true"] > svg { transform: rotate(180deg); }
.tour-topic-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tour-topic-menu { position: absolute; z-index: 30; top: calc(100% + .4rem); right: 0; width: max(100%, 16rem); max-width: calc(100vw - 2.5rem); max-height: 20rem; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; list-style: none; margin: 0; padding: .35rem; border: 1px solid var(--border-strong); border-radius: calc(.75rem * var(--radius-scale)); background: var(--surface-raised); color: var(--fg); }
.tour-topic-menu[data-side="above"] { top: auto; bottom: calc(100% + .4rem); }
.tour-topic-option { display: flex; align-items: center; justify-content: space-between; gap: .75rem; min-height: 44px; padding: .6rem .65rem; border-radius: calc(.4rem * var(--radius-scale)); line-height: 1.35; cursor: pointer; }
.tour-topic-option svg { width: 1rem; height: 1rem; flex-shrink: 0; visibility: hidden; }
.tour-topic-option[aria-selected="true"] { background: var(--accent-subtle); color: var(--accent); font-weight: 550; }
.tour-topic-option[aria-selected="true"] svg { visibility: visible; }
.tour-topic-option[data-active="true"], .tour-topic-option:hover { background: var(--surface-sunken); }
.tour-topic-option[aria-selected="true"][data-active="true"] { background: var(--accent-subtle); }
.tour-topic-option[data-active="true"] { outline: 1px solid var(--border-strong); outline-offset: -1px; }

.tour-count { min-width: 3.5rem; color: var(--muted); font-size: .75rem; font-variant-numeric: tabular-nums; text-align: center; }
.tour-arrow { display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 1px solid var(--border); border-radius: calc(.5rem * var(--radius-scale)); background: var(--surface); color: var(--fg); cursor: pointer; }
.tour-arrow svg { width: 1.15rem; height: 1.15rem; }
.tour-arrow[data-embla-prev] svg { transform: rotate(180deg); }
.tour-arrow:hover { background: var(--accent-subtle); border-color: var(--accent); color: var(--accent); }
.tour-arrow:active { background: var(--surface-sunken); }
.tour-note { color: var(--muted); font-size: .75rem; margin: 1rem 0 0; text-align: right; }
.section { padding-block: clamp(3.5rem, 7vw, 6rem); border-top: 1px solid var(--border); }
.section-tint { background: var(--surface-sunken); }
.s-head { font-family: var(--font-display); font-weight: var(--display-weight, 450); font-size: clamp(2rem, 3.5vw, 3.25rem); letter-spacing: -.025em; line-height: 1.1; max-width: 26ch; margin: 0; text-wrap: balance; }
.s-sub { color: var(--muted); max-width: 65ch; margin: 1.25rem 0 0; font-size: .95rem; }
.values { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2.5rem; }
.value h3 { font-family: var(--font-display); font-weight: var(--display-weight, 450); font-size: 1.7rem; line-height: 1.2; margin: 0 0 .8rem; }
.value p { color: var(--muted); font-size: .875rem; margin: 0; }
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: clamp(2rem, 6vw, 6rem); }
.ladder { border-top: 1px solid var(--border); }
.rung { padding: 1.2rem 0; border-bottom: 1px solid var(--border); }
.r-name { font-size: 1rem; font-weight: 550; }
.rung.feature .r-name { color: var(--accent); }
.r-tag { color: var(--muted); font-weight: 400; font-size: .75rem; margin-left: .5rem; }
.r-who, .ladder-note { color: var(--muted); font-size: .875rem; margin: .4rem 0 0; }
.ladder-note { margin-top: 1.5rem; }
.section-link { margin-top: 1rem; }
.prims { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: 2.5rem; margin-top: 2.5rem; }
.prim { position: relative; border-top: 1px solid var(--border); padding: 1.3rem 0 1.6rem 2rem; }
.ic { position: absolute; left: 0; top: 1.45rem; color: var(--accent); }
.ic svg { width: 1.15rem; height: 1.15rem; }
.prim h3 { font-size: .95rem; margin: 0 0 .5rem; font-weight: 550; }
.prim p { color: var(--muted); font-size: .875rem; margin: 0; }
.feats { margin-top: 2rem; }
.feat { border-top: 1px solid var(--border); }
.feat summary { cursor: pointer; font-size: .9rem; min-height: 44px; padding-block: 1rem; }
.feat summary:hover { color: var(--accent); }
.feat p { font-size: .875rem; color: var(--muted); margin: 0 0 1rem; }
.closing-inner { display: flex; align-items: center; justify-content: space-between; gap: 2rem; }
.closing .cta-row { flex-direction: column; align-items: flex-start; flex-shrink: 0; margin: 0; }
@media (max-width: 960px) { .hero-inner { grid-template-columns: 1fr 1fr; } h1 { font-size: clamp(2.8rem, 5vw, 3.8rem); } .slide { grid-template-columns: minmax(0, 13rem) minmax(0, 1fr); gap: 1.5rem; } .tour-caption { padding-top: .5rem; } .tour-caption h3 { font-size: 1.65rem; } .tour-controls { gap: .75rem; } .tour-heading h2 { font-size: 1.35rem; } }
@media (max-width: 760px) { .hero-inner, .split { grid-template-columns: 1fr; } .hero-inner { padding-block: 2rem; gap: 1.25rem; } h1 { font-size: clamp(2.6rem, 8vw, 3.8rem); } .lede { max-width: 54ch; } .tour-heading { gap: .75rem; } .tour-heading h2 { width: 100%; } .tour-controls { width: 100%; justify-content: space-between; } .tour-picker { gap: .5rem; min-width: 0; } .tour-picker select { min-width: 0; width: 12rem; } .slide { display: flex; flex-direction: column; gap: 0; } .shot { order: -1; width: 100%; } .tour-caption { padding-top: 1.25rem; max-width: 60ch; } .tour-caption h3 { font-size: 1.7rem; } .tour-caption p { margin-block: .75rem .25rem; } .tour-note { text-align: left; } .values { grid-template-columns: 1fr; gap: 2rem; } .prims { grid-template-columns: repeat(2, minmax(0, 1fr)); } .closing-inner { flex-direction: column; align-items: flex-start; } }
@media (max-width: 480px) { .tour-controls { flex-wrap: wrap; gap: .5rem; } .tour-picker { width: 100%; justify-content: space-between; } .tour-picker select, .tour-topic { flex: 1; } .tour-pagination { margin-left: auto; } .prims { grid-template-columns: 1fr; } .hero .cta-row { gap: .5rem; } .hero .btn { padding-inline: .8rem; } }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { transition: none !important; } }
@media (forced-colors: active) { html { scrollbar-color: auto; } ::selection { color: HighlightText; background: Highlight; } }
`;

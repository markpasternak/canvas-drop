import type { Config } from "@canvas-drop/shared";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { SESSION_COOKIE } from "../auth/session.js";
import { resolveRequest } from "../routing/resolve-request.js";
import { BRAND_MARK } from "./brand.js";
import { escapeHtml } from "./error-pages.js";
import { baseSecurityHeaders } from "./security-headers.js";
import { FAVICON_LINKS, ogMeta } from "./social-meta.js";
import type { AppEnv } from "./types.js";

/**
 * Public marketing front door (`/`) for signed-out visitors.
 *
 * Unlike the deliberately-plain legal pages (`/privacy`, `/terms`), this is a
 * designed, multi-section landing page: it introduces canvas-drop, drives
 * sign-in, and links out to docs, the gallery (as a screenshot — the live
 * gallery is gated), the OSS project, and the legal pages. It is self-rendered
 * static HTML with inline CSS + a sliver of vanilla JS (no SPA bundle, no
 * server-side build step) and is served BEFORE the auth gateway by `landingGate`
 * in `app.ts`, but only when the visitor has no session — a signed-in request to
 * `/` still falls through to the dashboard SPA.
 *
 * Visual language mirrors the dashboard design tokens (`tokens.css`): a cool
 * graphite ramp + a single indigo-violet accent, authored in OKLCH, Geist with a
 * system fallback. Screenshots are the committed, regenerable dark assets served at
 * `/docs/assets/landing-*.webp` (refresh with `pnpm landing:screenshots`).
 *
 * Operator-/instance-specific copy is centralized in `SITE` below — the single
 * place a self-hoster edits to re-flavor the page (mirrors `OPERATOR` in
 * `legal-pages.ts`). Everything else is generic to the canvas-drop product.
 */

/** Instance-specific copy. A self-hoster edits this one constant to re-flavor. */
const SITE = {
  name: "canvas-drop",
  domain: "canvas-drop.com",
  /** Hero promise — one line, product-true. */
  tagline: "Your organization's place to drop and share the tools you build with AI.",
  /** Short eyebrow above the headline. */
  eyebrow: "Internal canvases for your org",
  /** Big headline. Two short clauses read well at display scale. */
  headline: "Drop it in. Share it out.",
  /** Sub-headline beneath the H1. */
  subhead:
    "People build working web tools with AI in minutes, but they have nowhere safe to put them. canvas-drop is the creation-and-sharing layer: deploy a static canvas in seconds, share it with your team, and skip the screenshots and slide decks.",
  /** Open-source project URL. */
  githubUrl: "https://github.com/markpasternak/canvas-drop",
  /** SEO/meta description (plain text, ≤ ~160 chars). */
  metaDescription:
    "Deploy and share the small web tools your org builds with AI. Static canvases, live in seconds, behind your organization's sign-in.",
} as const;

/** The five backend primitives a canvas can reach (BUILD_BRIEF §11). */
const PRIMITIVES: ReadonlyArray<{ name: string; tag: string; blurb: string; glyph: string }> = [
  {
    name: "Key–value",
    tag: "kv",
    blurb: "Persist state with a tiny get/set store. No database to run.",
    glyph: "M4 7h16M4 12h16M4 17h10",
  },
  {
    name: "Files",
    tag: "files",
    blurb: "Upload, store, and serve assets straight from a canvas.",
    glyph: "M6 3h8l4 4v14H6zM14 3v4h4",
  },
  {
    name: "AI",
    tag: "ai",
    blurb: "Call the model through a server-side proxy, with no keys in the browser.",
    glyph: "M12 3v4M12 17v4M3 12h4M17 12h4M7 7l2 2M15 15l2 2M17 7l-2 2M9 15l-2 2",
  },
  {
    name: "Identity",
    tag: "me",
    blurb: "Know who's viewing. `me()` returns the signed-in org member.",
    glyph: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 20a7 7 0 0 1 14 0",
  },
  {
    name: "Realtime",
    tag: "live",
    blurb: "Broadcast and subscribe over a managed socket for live canvases.",
    glyph: "M5 12a7 7 0 0 1 14 0M8 12a4 4 0 0 1 8 0M12 12h.01",
  },
];

/** Three editorial value props for the band under the hero. */
const VALUES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Deploy in seconds",
    body: "Drag a folder or push from your agent. A canvas is just static files, so there's no build to wait on and nothing to provision.",
  },
  {
    title: "Shared with your org",
    body: "Every canvas lives behind your organization's sign-in. Invite a teammate, open a guest link, or publish to the gallery.",
  },
  {
    title: "Safe by default",
    body: "Org-only access, isolated runtimes, and server-side keys. Backend power comes only through five audited primitives.",
  },
];

/** Product-tour carousel slides → committed dark screenshots at /docs/assets.
 *  Refresh with `pnpm landing:screenshots` (after `pnpm seed:canvases`). */
const TOUR: ReadonlyArray<{ img: string; label: string; caption: string }> = [
  {
    img: "landing-dashboard",
    label: "Your dashboard",
    caption: "Every canvas your org has built, with versions, sharing, and status in one place.",
  },
  {
    img: "tour-editor",
    label: "In-browser editor",
    caption: "Edit files, preview, and publish a new version. No local setup, no deploy pipeline.",
  },
  {
    img: "landing-gallery",
    label: "Shared gallery",
    caption:
      "Browse, search, and clone what the team has made, instead of screenshots buried in a DM.",
  },
  {
    img: "tour-sharing",
    label: "Sharing & access",
    caption: "Per canvas: keep it org-only, invite a guest, or open an admin-gated public link.",
  },
  {
    img: "tour-capabilities",
    label: "Backend in a click",
    caption: "Switch on the primitives a canvas can use: KV, files, AI, identity, realtime.",
  },
  {
    img: "tour-admin",
    label: "Admin & control",
    caption: "Tune quotas, manage members, and set who can publish, all from the admin console.",
  },
  {
    img: "tour-usage",
    label: "Usage insight",
    caption: "See what's actually getting used, per canvas. No guesswork.",
  },
];

/** "Built for teams" — admin & control capabilities. */
const TEAM: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Org sign-in (SSO)",
    body: "Everyone signs in with your Google or OIDC org account, gated by email domain and an admin allowlist.",
  },
  {
    title: "Admin console",
    body: "Set global quotas and defaults, and choose which members may publish public links.",
  },
  {
    title: "Member management",
    body: "See who's in, grant or revoke admin, and block access in a click.",
  },
  {
    title: "Audit log",
    body: "Significant actions are recorded, so there's always an account of what changed.",
  },
];

/** "Private by design" — the privacy / security posture. */
const PRIVACY: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Org-only by default",
    body: "Every canvas sits behind your sign-in until you deliberately share it.",
  },
  {
    title: "No telemetry, ever",
    body: "canvas-drop never phones home. No tracking, no analytics, no third-party beacons.",
  },
  {
    title: "Secrets stay server-side",
    body: "AI and provider keys live on the server and are never shipped to the browser.",
  },
  {
    title: "Isolated runtimes",
    body: "Canvases are sandboxed, so they can't reach each other or the platform's internals.",
  },
  {
    title: "Your infrastructure",
    body: "Self-host on your own VPS or cloud; your data lives where you put it.",
  },
];

/**
 * Full document `<head>` — title, description, canonical, Open Graph + Twitter
 * card, theme-color, and JSON-LD. The OG/Twitter image is the shared `/og.png`
 * card (absolute URL — crawlers require it). Unlike the gated surfaces this page
 * is `index,follow`: it is meant to be discoverable.
 */
function head(origin: string): string {
  const base = origin.replace(/\/$/, "");
  const title = `${SITE.name} · ${SITE.tagline}`;
  const desc = SITE.metaDescription;
  const url = `${base}/`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE.name,
    url,
    description: desc,
    sameAs: [SITE.githubUrl],
  });
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${ogMeta({ origin, path: "/", title, description: desc })}
${FAVICON_LINKS}
<link rel="alternate" type="text/plain" href="/llms.txt" title="LLM-readable docs">
<meta name="theme-color" content="#0b0b0f" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">
<script type="application/ld+json">${jsonLd}</script>
<style>${STYLES}</style>`;
}

/**
 * All page CSS. The `:root` OKLCH ramp below is a HAND-MAINTAINED FORK of the
 * dashboard's design tokens (`apps/dashboard/src/styles/tokens.css`, the
 * `--canvas … --accent` semantic vars): this page is served pre-gateway and
 * cannot import the SPA's CSS bundle. If the token ramp changes there, sync the
 * values here — nothing fails a build or test if they drift.
 */
const STYLES = `
:root {
  --canvas: oklch(0.968 0.0025 264);
  --surface: oklch(0.995 0.0015 264);
  --surface-sunken: oklch(0.945 0.004 264);
  --fg: oklch(0.235 0.013 266);
  --muted: oklch(0.475 0.013 266);
  --subtle: oklch(0.555 0.012 266);
  --border: oklch(0.905 0.005 264);
  --accent: oklch(0.515 0.214 274);
  --accent-hover: oklch(0.455 0.205 274);
  --accent-fg: oklch(0.99 0.012 274);
  --logo-frame: oklch(0.24 0.014 266);
  --logo-drop: oklch(0.515 0.214 274);
  --shadow-color: 265 24% 16%;
  --shadow-panel: 0 1px 2px hsl(var(--shadow-color)/0.05), 0 4px 12px hsl(var(--shadow-color)/0.07);
  --shadow-lg: 0 24px 56px hsl(var(--shadow-color)/0.18), 0 6px 16px hsl(var(--shadow-color)/0.1);
  --ink: oklch(0.16 0.008 266);
  --ink-2: oklch(0.205 0.011 266);
  --on-ink: oklch(0.97 0.003 266);
  --on-ink-muted: oklch(0.74 0.012 266);
  --on-ink-border: oklch(1 0 0 / 0.1);
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  --maxw: 72rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: oklch(0.155 0.006 266);
    --surface: oklch(0.192 0.007 266);
    --surface-sunken: oklch(0.128 0.005 266);
    --fg: oklch(0.965 0.003 266);
    --muted: oklch(0.705 0.013 266);
    --subtle: oklch(0.585 0.013 266);
    --border: oklch(0.272 0.008 266);
    --accent: oklch(0.685 0.18 274);
    --accent-hover: oklch(0.75 0.16 274);
    --accent-fg: oklch(0.16 0.045 274);
    --logo-frame: oklch(0.965 0.003 266);
    --logo-drop: oklch(0.685 0.18 274);
    --shadow-color: 265 50% 1%;
    --ink: oklch(0.115 0.006 266);
    --ink-2: oklch(0.16 0.008 266);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--fg);
  font: 16px/1.6 "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: inherit; text-decoration: none; }
.wrap { width: min(100%, var(--maxw)); margin-inline: auto; padding-inline: clamp(1.25rem, 5vw, 2.5rem); }
.mono { font-family: "Geist Mono Variable", ui-monospace, "SF Mono", Menlo, monospace; }

/* --- top bar --- */
header {
  position: sticky; top: 0; z-index: 20;
  background: color-mix(in oklab, var(--ink) 78%, transparent);
  backdrop-filter: saturate(1.4) blur(12px);
  border-bottom: 1px solid var(--on-ink-border);
}
.nav { display: flex; align-items: center; gap: 1rem; height: 4rem; }
.brand { display: flex; align-items: center; gap: .55rem; font-weight: 650; letter-spacing: -.012em; color: var(--on-ink); }
.brand .mark { width: 1.65rem; height: 1.65rem; }
.brand--ink { --logo-frame: var(--on-ink); --logo-drop: oklch(0.7 0.17 274); }
.nav .spacer { flex: 1; }
.nav-links { display: flex; align-items: center; gap: .35rem; }
.nav a.link { color: var(--on-ink-muted); padding: .45rem .7rem; border-radius: .5rem; font-size: .92rem; transition: color .15s var(--ease), background .15s var(--ease); }
.nav a.link:hover { color: var(--on-ink); background: oklch(1 0 0 / 0.06); }
@media (max-width: 640px) { .nav a.link.hide-sm { display: none; } }

/* --- buttons --- */
.btn {
  display: inline-flex; align-items: center; gap: .5rem;
  padding: .62rem 1.05rem; border-radius: .625rem;
  font-weight: 560; font-size: .94rem; letter-spacing: -.005em;
  border: 1px solid transparent; cursor: pointer;
  transition: transform .15s var(--ease), background .15s var(--ease), border-color .15s var(--ease), box-shadow .15s var(--ease);
}
.btn-primary { background: var(--accent); color: var(--accent-fg); box-shadow: 0 1px 0 oklch(1 0 0 / 0.18) inset, var(--shadow-panel); }
.btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); }
.btn-ghost { background: oklch(1 0 0 / 0.04); color: var(--on-ink); border-color: var(--on-ink-border); }
.btn-ghost:hover { background: oklch(1 0 0 / 0.09); transform: translateY(-1px); }
.btn-outline { background: transparent; color: var(--fg); border-color: var(--border); }
.btn-outline:hover { border-color: var(--accent); color: var(--accent); transform: translateY(-1px); }
.btn svg { width: 1.05em; height: 1.05em; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: .25rem; }

/* --- hero --- */
.hero {
  position: relative; overflow: hidden;
  background:
    radial-gradient(120% 90% at 84% -10%, oklch(0.515 0.214 274 / 0.42), transparent 60%),
    radial-gradient(90% 70% at 8% 6%, oklch(0.6 0.16 286 / 0.18), transparent 55%),
    linear-gradient(180deg, var(--ink-2), var(--ink));
  color: var(--on-ink);
  border-bottom: 1px solid var(--on-ink-border);
}
.hero::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background-image: linear-gradient(var(--on-ink-border) 1px, transparent 1px), linear-gradient(90deg, var(--on-ink-border) 1px, transparent 1px);
  background-size: 56px 56px;
  -webkit-mask-image: radial-gradient(120% 80% at 50% 0%, #000 35%, transparent 72%);
  mask-image: radial-gradient(120% 80% at 50% 0%, #000 35%, transparent 72%);
  opacity: .5;
}
.hero-inner { position: relative; padding-block: clamp(0.75rem, 2vw, 1.5rem) clamp(1.25rem, 2.5vw, 2rem); }
.eyebrow {
  display: inline-flex; align-items: center; gap: .5rem;
  font-size: .8rem; letter-spacing: .02em; color: var(--on-ink-muted);
  border: 1px solid var(--on-ink-border); border-radius: 100px; padding: .3rem .7rem;
  background: oklch(1 0 0 / 0.03);
}
.eyebrow .dot { width: .42rem; height: .42rem; border-radius: 100px; background: oklch(0.7 0.17 274); box-shadow: 0 0 0 4px oklch(0.7 0.17 274 / 0.22); }
h1 {
  margin: 1.1rem 0 0; max-width: 16ch;
  font-size: clamp(2.6rem, 7vw, 4.6rem); line-height: 1.02; letter-spacing: -.035em; font-weight: 660;
}
h1 .accent { color: oklch(0.78 0.15 274); }
.lede { margin: 1.4rem 0 0; max-width: 46ch; font-size: clamp(1.02rem, 2.2vw, 1.22rem); color: var(--on-ink-muted); }
.cta-row { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 2rem; }
.cue { margin-top: 1rem; font-size: .85rem; color: var(--on-ink-muted); }
.cue .mono { color: var(--on-ink); }

/* --- section scaffolding --- */
section { padding-block: clamp(1.5rem, 3vw, 2.25rem); }
.kicker { font-size: .8rem; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
.s-head { max-width: 34ch; margin: .7rem 0 0; font-size: clamp(1.7rem, 4vw, 2.5rem); line-height: 1.08; letter-spacing: -.025em; font-weight: 640; }
.s-sub { max-width: 52ch; margin: .9rem 0 0; color: var(--muted); font-size: 1.05rem; }

/* value band */
.values { display: grid; gap: clamp(1.5rem, 4vw, 2.5rem); grid-template-columns: repeat(3, 1fr); margin-top: clamp(1.5rem, 3.5vw, 2.25rem); }
@media (max-width: 800px) { .values { grid-template-columns: 1fr; } }
.value h3 { margin: 0 0 .5rem; font-size: 1.15rem; letter-spacing: -.01em; }
.value .num { font-family: "Geist Mono Variable", ui-monospace, monospace; color: var(--accent); font-size: .85rem; }
.value p { margin: .25rem 0 0; color: var(--muted); }
.value { border-top: 1px solid var(--border); padding-top: 1.1rem; }

/* primitives showcase */
.prims { display: grid; gap: 1px; grid-template-columns: repeat(5, 1fr); margin-top: clamp(1.5rem, 3.5vw, 2.25rem); background: var(--border); border: 1px solid var(--border); border-radius: .875rem; overflow: hidden; }
@media (max-width: 900px) { .prims { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 520px) { .prims { grid-template-columns: 1fr; } }
.prim { background: var(--surface); padding: 1.5rem 1.35rem; transition: background .15s var(--ease), transform .15s var(--ease); }
.prim:hover { background: var(--surface-sunken); }
.prim .ic { width: 2.1rem; height: 2.1rem; display: grid; place-items: center; border-radius: .55rem; border: 1px solid var(--border); color: var(--accent); margin-bottom: .9rem; }
.prim .ic svg { width: 1.15rem; height: 1.15rem; }
.prim h4 { margin: 0; font-size: 1.02rem; letter-spacing: -.01em; }
.prim .tag { font-family: "Geist Mono Variable", ui-monospace, monospace; font-size: .72rem; color: var(--subtle); }
.prim p { margin: .5rem 0 0; font-size: .9rem; color: var(--muted); line-height: 1.5; }

/* framed screenshot (carousel slides) */
.shot { border: 1px solid var(--border); border-radius: .875rem; overflow: hidden; box-shadow: var(--shadow-panel); background: var(--surface); }
.shot img { display: block; width: 100%; height: auto; }

/* open-source CTA */
.oss { background: linear-gradient(180deg, var(--ink-2), var(--ink)); color: var(--on-ink); border-block: 1px solid var(--on-ink-border); }
.oss .wrap { text-align: center; }
.oss .s-head { margin-inline: auto; max-width: 22ch; }
.oss .s-sub { margin-inline: auto; color: var(--on-ink-muted); }
.oss .cta-row { justify-content: center; }

/* footer */
footer { background: var(--surface); border-top: 1px solid var(--border); padding-block: 3rem; }
.foot { display: flex; flex-wrap: wrap; gap: 1.5rem 2.5rem; align-items: center; }
.foot .spacer { flex: 1; }
.foot-links { display: flex; flex-wrap: wrap; gap: .35rem 1.25rem; }
.foot-links a { color: var(--muted); font-size: .92rem; transition: color .15s var(--ease); }
.foot-links a:hover { color: var(--fg); }
.colophon { width: 100%; margin-top: 1.75rem; padding-top: 1.5rem; border-top: 1px solid var(--border); color: var(--subtle); font-size: .82rem; }

/* product tour carousel — native CSS scroll-snap (the browser positions the
   slides; JS only drives autoplay + the dot/arrow controls). No transform math. */
.carousel { position: relative; margin-top: clamp(1.5rem, 3.5vw, 2.25rem); }
.viewport {
  display: flex;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x mandatory;
  scroll-behavior: smooth;
  scrollbar-width: none;            /* Firefox — hide the scrollbar */
  -ms-overflow-style: none;
}
.viewport::-webkit-scrollbar { display: none; }
/* Each slide is exactly the viewport width and a snap target. margin:0 resets the
   UA default figure margin-inline (40px), which would otherwise offset the slide. */
.slide { flex: 0 0 100%; min-width: 0; margin: 0; scroll-snap-align: start; scroll-snap-stop: always; }
.slide .shot { box-shadow: var(--shadow-lg); }
.slide figcaption { margin: 1.1rem auto 0; max-width: 54ch; text-align: center; color: var(--muted); font-size: 1.02rem; }
.slide figcaption strong { color: var(--fg); font-weight: 600; }
.car-btn {
  position: absolute; top: calc(50% - 2.5rem); transform: translateY(-50%);
  display: grid; place-items: center; width: 2.6rem; height: 2.6rem;
  border-radius: 100px; border: 1px solid var(--border); background: var(--surface);
  color: var(--fg); cursor: pointer; box-shadow: var(--shadow-panel);
  transition: background .15s var(--ease), border-color .15s var(--ease), transform .15s var(--ease);
}
.car-btn:hover { border-color: var(--accent); color: var(--accent); }
.car-btn:active { transform: translateY(-50%) scale(.94); }
.car-btn svg { width: 1.2rem; height: 1.2rem; }
.car-prev { left: -.6rem; }
.car-next { right: -.6rem; }
@media (max-width: 760px) { .car-btn { display: none; } }
.dots { display: flex; gap: .5rem; justify-content: center; margin-top: 1.4rem; }
.dot {
  width: .5rem; height: .5rem; padding: 0; border: 0; border-radius: 100px;
  background: var(--border); cursor: pointer; transition: background .2s var(--ease), width .2s var(--ease);
}
.dot[aria-current="true"] { background: var(--accent); width: 1.5rem; }

/* feature grids (Built for teams / Private by design) */
.feats { display: grid; grid-template-columns: repeat(2, 1fr); gap: clamp(1.25rem, 3vw, 2.25rem); margin-top: clamp(1.5rem, 3.5vw, 2.25rem); }
@media (max-width: 720px) { .feats { grid-template-columns: 1fr; } }
.feat { border-top: 1px solid var(--border); padding-top: 1rem; }
.feat h3 { margin: 0 0 .35rem; display: flex; align-items: flex-start; gap: .55rem; font-size: 1.05rem; letter-spacing: -.01em; }
.feat h3 svg { width: 1.05rem; height: 1.05rem; flex: 0 0 auto; margin-top: .15rem; color: var(--accent); }
.feat p { margin: 0; color: var(--muted); font-size: .95rem; line-height: 1.55; }

/* dark band (Private by design) — reuse the hero ink + on-ink tokens */
.band-dark { background: linear-gradient(180deg, var(--ink-2), var(--ink)); color: var(--on-ink); border-top: 1px solid var(--on-ink-border); }
.band-dark .s-sub { color: var(--on-ink-muted); }
.band-dark .kicker { color: oklch(0.78 0.15 274); }
.band-dark .feat { border-top-color: var(--on-ink-border); }
.band-dark .feat h3 { color: var(--on-ink); }
.band-dark .feat h3 svg { color: oklch(0.8 0.13 274); }
.band-dark .feat p { color: var(--on-ink-muted); }
.band-dark a { color: oklch(0.8 0.13 274); }

/* --- entrance + scroll reveal --- */
.reveal { opacity: 0; transform: translateY(16px); transition: opacity .6s var(--ease), transform .6s var(--ease); }
.reveal.in { opacity: 1; transform: none; }
.hero [data-stagger] { opacity: 0; transform: translateY(14px); animation: rise .7s var(--ease) forwards; }
.hero [data-stagger="1"] { animation-delay: .05s; }
.hero [data-stagger="2"] { animation-delay: .14s; }
.hero [data-stagger="3"] { animation-delay: .23s; }
.hero [data-stagger="4"] { animation-delay: .32s; }
.hero [data-stagger="5"] { animation-delay: .44s; }
@keyframes rise { to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  html, .viewport { scroll-behavior: auto; }
  .reveal, .hero [data-stagger] { opacity: 1; transform: none; animation: none; transition: none; }
}
`;

const check = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 13 4 4L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ghIcon = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.65.35-1.1.63-1.35-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>`;
const arrow = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const arrowLeft = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** One carousel slide: a framed dark screenshot + a caption. */
function tourSlide(t: (typeof TOUR)[number]): string {
  return `<figure class="slide">
  <div class="shot"><img src="/docs/assets/${t.img}.webp" width="1440" height="900" alt="${escapeHtml(`${t.label}. ${t.caption}`)}" loading="lazy" decoding="async"></div>
  <figcaption><strong>${escapeHtml(t.label)}.</strong> ${escapeHtml(t.caption)}</figcaption>
</figure>`;
}

/** One feature item (check glyph + title + blurb) for the Teams / Privacy grids. */
function featItem(f: { title: string; body: string }): string {
  return `<div class="feat"><h3>${check}${escapeHtml(f.title)}</h3><p>${escapeHtml(f.body)}</p></div>`;
}

function primitiveCard(p: (typeof PRIMITIVES)[number]): string {
  return `<div class="prim">
  <div class="ic"><svg viewBox="0 0 24 24" fill="none"><path d="${p.glyph}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
  <h4>${escapeHtml(p.name)} <span class="tag">${escapeHtml(p.tag)}</span></h4>
  <p>${escapeHtml(p.blurb)}</p>
</div>`;
}

/** Render the full landing page HTML. `origin` is `config.baseUrl` (for absolute OG URLs). */
export function renderLandingPage(
  origin = "",
  authMode: Config["auth"]["mode"] = "oidc",
  signedIn = false,
): string {
  // Primary CTA target. A signed-in viewer (only possible on the always-public
  // `/welcome` alias — `/` only renders this page when signed out) gets a direct
  // "Open dashboard" link so the front door is never a re-login dead-end. Otherwise
  // the target depends on auth mode: only `oidc` has an app-owned login page
  // (`/auth/login`); `dev` (auto-signed-in) and `proxy` (IAP-fronted) have none, so
  // the CTA opens the app at `/` instead of 404-ing.
  const cta = signedIn
    ? { href: "/", label: "Open dashboard", short: "Dashboard" }
    : authMode === "oidc"
      ? { href: "/auth/login", label: "Sign in with your org", short: "Sign in" }
      : { href: "/", label: "Open canvas-drop", short: "Open app" };

  const values = VALUES.map(
    (v, i) =>
      `<div class="value reveal"><span class="num">0${i + 1}</span><h3>${escapeHtml(v.title)}</h3><p>${escapeHtml(v.body)}</p></div>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
${head(origin)}
</head>
<body>
<header>
  <div class="wrap nav">
    <a class="brand brand--ink" href="/">${BRAND_MARK}<span>${escapeHtml(SITE.name)}</span></a>
    <span class="spacer"></span>
    <nav class="nav-links" aria-label="Primary">
      <a class="link hide-sm" href="/docs">Docs</a>
      <a class="link hide-sm" href="${escapeHtml(SITE.githubUrl)}" target="_blank" rel="noopener noreferrer">GitHub</a>
      <a class="btn btn-ghost" href="${cta.href}">${cta.short}</a>
    </nav>
  </div>
</header>

<main>
  <section class="hero">
    <div class="wrap hero-inner">
      <span class="eyebrow" data-stagger="1"><span class="dot"></span>${escapeHtml(SITE.eyebrow)}</span>
      <h1 data-stagger="2">Drop it in.<br><span class="accent">Share it out.</span></h1>
      <p class="lede" data-stagger="3">${escapeHtml(SITE.subhead)}</p>
      <div class="cta-row" data-stagger="4">
        <a class="btn btn-primary" href="${cta.href}">${cta.label} ${arrow}</a>
        <a class="btn btn-ghost" href="/docs">Read the docs</a>
      </div>
      <p class="cue" data-stagger="4">Or deploy from your agent: <span class="mono">curl -F</span> a folder and it's live.</p>
    </div>
  </section>

  <section style="background:var(--surface-sunken);border-block:1px solid var(--border)">
    <div class="wrap">
      <p class="kicker reveal">A guided tour</p>
      <h2 class="s-head reveal">See it across the whole workflow.</h2>
      <p class="s-sub reveal">Create, edit, share, and govern. Every surface of canvas-drop, in one place.</p>
      <div class="carousel reveal" data-carousel aria-roledescription="carousel" aria-label="Product tour">
        <div class="viewport">
${TOUR.map(tourSlide).join("\n")}
        </div>
        <button class="car-btn car-prev" type="button" aria-label="Previous screen">${arrowLeft}</button>
        <button class="car-btn car-next" type="button" aria-label="Next screen">${arrow}</button>
        <div class="dots" role="tablist" aria-label="Choose screen">
${TOUR.map((t, i) => `          <button class="dot" type="button" role="tab" aria-label="${escapeHtml(t.label)}"${i === 0 ? ' aria-current="true"' : ""}></button>`).join("\n")}
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <p class="kicker reveal">Why canvas-drop</p>
      <h2 class="s-head reveal">From “I built a thing” to “the team is using it,” without a deploy pipeline.</h2>
      <div class="values">
${values}
      </div>
    </div>
  </section>

  <section style="background:var(--surface-sunken);border-block:1px solid var(--border)">
    <div class="wrap">
      <p class="kicker reveal">Five primitives</p>
      <h2 class="s-head reveal">Static canvases, real backend power.</h2>
      <p class="s-sub reveal">Canvases ship as static files, with no server build. When a canvas needs more, it reaches exactly five audited primitives. Secrets stay server-side, always.</p>
      <div class="prims reveal">
${PRIMITIVES.map(primitiveCard).join("\n")}
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <p class="kicker reveal">Built for teams</p>
      <h2 class="s-head reveal">Control, without the overhead.</h2>
      <p class="s-sub reveal">canvas-drop is built for your whole org from day one. Access, limits, and accountability come standard, not bolted on.</p>
      <div class="feats reveal">
${TEAM.map(featItem).join("\n")}
      </div>
    </div>
  </section>

  <section class="band-dark">
    <div class="wrap">
      <p class="kicker reveal">Private by design</p>
      <h2 class="s-head reveal">Your tools, your data, your infrastructure.</h2>
      <p class="s-sub reveal">Privacy isn't a setting here. It's the default posture: canvas-drop keeps the minimum it needs to run, and nothing leaves your instance.</p>
      <div class="feats reveal">
${PRIVACY.map(featItem).join("\n")}
      </div>
      <p class="s-sub reveal" style="margin-top:1.75rem">Read the <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Service</a>.</p>
    </div>
  </section>

  <section class="oss">
    <div class="wrap">
      <p class="kicker reveal" style="color:oklch(0.78 0.15 274)">Open source</p>
      <h2 class="s-head reveal">Yours to run. MIT-licensed, self-hostable.</h2>
      <p class="s-sub reveal">canvas-drop is open source and self-contained: one binary, your database, your storage, your sign-in. No telemetry, no phone-home. Host it on a single VPS or bring your own cloud.</p>
      <div class="cta-row reveal">
        <a class="btn btn-ghost" href="${escapeHtml(SITE.githubUrl)}" target="_blank" rel="noopener noreferrer">${ghIcon} View on GitHub</a>
        <a class="btn btn-ghost" href="/docs">Self-host guide ${arrow}</a>
      </div>
    </div>
  </section>
</main>

<footer>
  <div class="wrap">
    <div class="foot">
      <a class="brand" style="color:var(--fg)" href="/">${BRAND_MARK}<span>${escapeHtml(SITE.name)}</span></a>
      <span class="spacer"></span>
      <nav class="foot-links" aria-label="Footer">
        <a href="/docs">Docs</a>
        <a href="${escapeHtml(SITE.githubUrl)}" target="_blank" rel="noopener noreferrer">GitHub</a>
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
        <a href="${cta.href}">${cta.short}</a>
      </nav>
    </div>
    <div class="colophon">${escapeHtml(SITE.name)} is your organization's creation-and-sharing layer for AI-built tools. Open source under the MIT license.</div>
  </div>
</footer>

<script>
var REDUCE = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Scroll-reveal (skipped entirely under reduced-motion).
(function () {
  if (REDUCE) {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
  document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
})();
// Product-tour carousel — native CSS scroll-snap. JS only scrolls the viewport
// for the arrows/dots/autoplay and reflects the current slide in the dots. The
// browser owns positioning, so there's no transform math to get wrong.
(function () {
  document.querySelectorAll('[data-carousel]').forEach(function (car) {
    var vp = car.querySelector('.viewport');
    var slides = car.querySelectorAll('.slide');
    var dots = car.querySelectorAll('.dot');
    var timer = null, scrollT = null;
    function index() { return Math.round(vp.scrollLeft / vp.clientWidth); }
    function goTo(n) {
      var from = index();
      var i = (n + slides.length) % slides.length;
      // Wrapping (a multi-step jump) snaps instantly; a single step animates.
      vp.scrollTo({ left: i * vp.clientWidth, behavior: (REDUCE || Math.abs(i - from) > 1) ? 'auto' : 'smooth' });
    }
    function syncDots() {
      var i = index();
      dots.forEach(function (d, k) { d.setAttribute('aria-current', k === i ? 'true' : 'false'); });
    }
    var prev = car.querySelector('.car-prev');
    var next = car.querySelector('.car-next');
    if (prev) prev.addEventListener('click', function () { goTo(index() - 1); restart(); });
    if (next) next.addEventListener('click', function () { goTo(index() + 1); restart(); });
    dots.forEach(function (d, k) { d.addEventListener('click', function () { goTo(k); restart(); }); });
    vp.addEventListener('scroll', function () { clearTimeout(scrollT); scrollT = setTimeout(syncDots, 80); }, { passive: true });
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function start() { stop(); if (!REDUCE) timer = setInterval(function () { goTo(index() + 1); }, 5200); }
    function restart() { start(); }
    car.addEventListener('mouseenter', stop);
    car.addEventListener('mouseleave', start);
    car.addEventListener('focusin', stop);
    car.addEventListener('focusout', start);
    syncDots(); start();
  });
})();
</script>
</body>
</html>`;
}

/**
 * Front-door gate: render the marketing landing for a signed-out `GET /`, but
 * step aside for everything else so the request continues to the auth gateway +
 * dashboard SPA. Mounted BEFORE `socialPreview` and the gateway in `app.ts`.
 *
 * Only active in `oidc` mode — `proxy` mode is IAP-fronted (a signed-out request
 * never reaches the app) and `dev` mode is always signed in (so `/` is the SPA).
 * A signed-in visitor is detected by the mere PRESENCE of the session cookie (a
 * cheap check, mirroring `socialPreview`): present → fall through so the gateway
 * resolves it and serves the dashboard. We deliberately do NOT call
 * `resolveIdentity` here — in oidc mode that slides the session (a DB write + a
 * fresh `Set-Cookie`), and the gateway re-resolves anyway, so peeking would double
 * the work and emit two `Set-Cookie`s on the hottest authed path. An expired
 * cookie still falls through and the gateway redirects to login — never worse.
 */
export function landingGate(deps: { config: Config }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (deps.config.auth.mode !== "oidc") return next();
    if (c.req.path !== "/") return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    // A guest/public principal (U7) is a real canvas visitor, not a front-door hit.
    if (c.get("principal")) return next();
    // A session cookie → (possibly) signed-in human → let the gateway serve the SPA.
    if (getCookie(c, SESSION_COOKIE)) return next();
    // Only the BASE host has a marketing front door. On a canvas subdomain, `/` is the
    // canvas root — falling through lets social-preview/the gateway redirect to login
    // carrying a returnTo, so a signed-out visitor lands back on the canvas after
    // sign-in instead of on the generic welcome page (which has no returnTo CTA).
    const { role } = resolveRequest(
      { host: c.req.header("host") ?? "", pathname: c.req.path },
      deps.config,
    );
    if (role === "canvas") return next();
    return landingResponse(deps.config);
  });
}

/**
 * HTML response for the landing page. `signedIn` (cookie-presence on the
 * always-public `/welcome` alias) swaps the CTA to "Open dashboard" so a signed-in
 * member is never sent to a re-login. The CTA varies by session, so the response
 * is `private` + `Vary: Cookie` — a shared/CDN cache must never serve one auth
 * state's page to the other.
 */
export function landingResponse(config: Config, opts: { signedIn?: boolean } = {}): Response {
  const headers = new Headers();
  baseSecurityHeaders(headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  // Inline <style> + one inline <script> for the scroll-reveal; lock down framing.
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("Vary", "Cookie");
  return new Response(renderLandingPage(config.baseUrl, config.auth.mode, opts.signedIn ?? false), {
    status: 200,
    headers,
  });
}

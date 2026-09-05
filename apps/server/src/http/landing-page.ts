import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, SkinName } from "@canvas-drop/shared";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { SESSION_COOKIE } from "../auth/session.js";
import { resolveRequest } from "../routing/resolve-request.js";
import { escapeHtml } from "./error-pages.js";
import { LANDING_LAYOUT } from "./landing-design.js";
import { baseSecurityHeaders } from "./security-headers.js";
import { SITE_STYLES, SITE_THEME_SCRIPT, siteFooter, siteHeader } from "./site-chrome.js";
import { skinnedHtmlTag } from "./skin-html.js";
import { FAVICON_LINKS, ogMeta } from "./social-meta.js";
import type { AppEnv } from "./types.js";

/** Public front door with a multi-view product walkthrough and auth-mode-aware sign-in. */

/** Instance-specific copy. A self-hoster edits this one constant to re-flavor. */
const SITE = {
  name: "canvas-drop",
  domain: "canvas-drop.com",
  /** Hero promise: one line, product-true. */
  tagline: "Deploy and share your org's small web tools, behind your sign-in.",
  /** Short eyebrow above the headline. */
  eyebrow: "Self-hosted canvases for your org",
  /** Big headline. Two short clauses read well at display scale. */
  headline: "Drop it in. Share it out.",
  /** Sub-headline beneath the H1. */
  subhead:
    "Made in a chat, a cloud workspace, or on your laptop. Useful work shouldn’t stay trapped where it was created. Give it a home your team can access, improve, and use together.",
  /** Open-source project URL. */
  githubUrl: "https://github.com/markpasternak/canvas-drop",
  /** SEO/meta description (plain text, ≤ ~160 chars). */
  metaDescription:
    "Deploy and share your org's small web tools. Static canvases, live in seconds, behind your sign-in. AI agents deploy over MCP. Open source, self-hosted.",
} as const;

/** The six runtime primitives (BUILD_BRIEF §11) plus the separately gated authoring capability. */
const BACKEND_CAPABILITIES: ReadonlyArray<{
  name: string;
  tag: string;
  blurb: string;
  glyph: string;
  glyphFill?: boolean;
  viewBox?: string;
}> = [
  {
    name: "Key-value",
    tag: "kv",
    blurb: "Get, set, and increment keys, shared or per user. No database to run.",
    glyph: "M4 7h16M4 12h16M4 17h10",
  },
  {
    name: "Files",
    tag: "files",
    blurb: "Upload, list, and serve files from the canvas itself.",
    glyph: "M6 3h8l4 4v14H6zM14 3v4h4",
  },
  {
    name: "AI",
    tag: "ai",
    blurb:
      "Chat and stream through a server-side proxy. The provider key never reaches the browser.",
    glyph: "M12 3v4M12 17v4M3 12h4M17 12h4M7 7l2 2M15 15l2 2M17 7l-2 2M9 15l-2 2",
  },
  {
    name: "Identity",
    tag: "identity",
    blurb: "Know who is viewing. me() returns the signed-in org member, resolved server-side.",
    glyph: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 20a7 7 0 0 1 14 0",
  },
  {
    name: "Realtime",
    tag: "realtime",
    blurb: "Publish, subscribe, and see who's present over a managed socket. No server to run.",
    glyph: "M5 12a7 7 0 0 1 14 0M8 12a4 4 0 0 1 8 0M12 12h.01",
  },
  {
    name: "Connections",
    tag: "connections",
    blurb:
      "Call approved third-party APIs through exact-origin profiles. Credentials stay server-side.",
    glyph:
      "M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.14-1.14",
  },
  {
    name: "Authoring",
    tag: "authoring",
    blurb:
      "Let signed-in viewers create and manage canvases as themselves. Off by default, instance-wide and per canvas.",
    // PencilSimple, regular weight, from the MIT-licensed Phosphor icon set used by the dashboard.
    glyph:
      "M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z",
    glyphFill: true,
    viewBox: "0 0 256 256",
  },
];

/** Three editorial value props for the band under the hero. */
const VALUES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Bring your work with you",
    body: "Publish exported HTML, a folder, or a ZIP from the tools you already use. Connect an agent over MCP to create and update canvases directly.",
  },
  {
    title: "Let the right people use it",
    body: "Share through your organization’s sign-in. Add colleagues and teams as viewers or editors, with access you can change or revoke. Public links follow your admin’s policy.",
  },
  {
    title: "Keep building on it",
    body: "Edit and preview a draft while the current version stays available. Publish updates to the same link, restore an earlier version, or offer your canvas as a template.",
  },
];

/** The per-canvas access ladder (the sharing model, plan 003). Rendered as a marketing
 *  visual. The landing is the widest-reaching surface for the team + invite story. Order
 *  reads top-down the way the Share tab does: the people-and-teams list first (it always
 *  applies), then the three General-access choices (Restricted → Whole org → Public link). */
const LADDER: ReadonlyArray<{ rung: string; who: string; tag?: string; feature?: boolean }> = [
  {
    rung: "People & teams",
    who: "Name a colleague by email, or a team you create once and grant anywhere — each a viewer or an editor. Whatever you pick below, they're in.",
    feature: true,
  },
  { rung: "Restricted", who: "Nobody else. With no one added, that's just you." },
  { rung: "Whole org", who: "Anyone signed in to your organization." },
  {
    rung: "Public link",
    who: "Anyone with the URL. Static files only; admins can switch it off instance-wide or per account.",
    tag: "admin",
  },
];

/** Product-tour carousel slides → committed light screenshots at /docs/assets.
 *  Refresh with `pnpm landing:screenshots` (after `pnpm seed:canvases`). */
const TOUR: ReadonlyArray<{ img: string; label: string; caption: string }> = [
  {
    img: "landing-dashboard",
    label: "Your dashboard",
    caption:
      "Every canvas you own or edit. Search by title, description, tag, or slug; filter by access, status, or role; and see the current version and sharing at a glance.",
  },
  {
    img: "tour-editor",
    label: "In-browser editor",
    caption:
      "Edit files with autosave, preview the draft, and publish a new version. No local setup, no deploy pipeline.",
  },
  {
    img: "tour-shared",
    label: "Shared with you",
    caption:
      "Canvases other people opened to you, directly or through a team or the whole org. Search, sort by owner or last update, and open the right one fast.",
  },
  {
    img: "landing-gallery",
    label: "Opt-in gallery",
    caption:
      "Browse public canvases and the org-wide ones their owners chose to list. Search, filter by tag, and start from any one marked as a template. Admins can feature their picks.",
  },
  {
    img: "tour-preview",
    label: "Preview covers",
    caption:
      "Choose each canvas's cover: an automatic screenshot on publish where your instance has capture switched on, none, or an image you upload that survives every publish.",
  },
  {
    img: "tour-sharing",
    label: "Share link & access",
    caption:
      "Copy the live URL, choose who else can open it — Restricted, Whole org, or Public link — and add a password or an expiry. People and teams you add always get in.",
  },
  {
    img: "tour-people",
    label: "People & editors",
    caption:
      "One people list per canvas. Add a person or a team as a viewer or an editor. Editors run the canvas with you, and the owner can hand it to any editor from the same list.",
  },
  {
    img: "tour-teams",
    label: "Teams & invites",
    caption:
      "Make a team once and grant it on any canvas. Add people by email before they have ever signed in; they're in the moment they first sign in through your org's auth, with no password for you to manage.",
  },
  {
    img: "tour-capabilities",
    label: "Backend in a click",
    caption:
      "The backend is off until you switch it on. Then add data, files, AI, identity, realtime, or controlled third-party requests through admin-granted Connections.",
  },
  {
    img: "tour-admin",
    label: "Admin & control",
    caption:
      "Set AI quotas, manage members, disable a canvas with a stated reason, and choose who may publish public links.",
  },
  {
    img: "tour-usage",
    label: "Usage insight",
    caption:
      "Views, unique viewers, and a 30-day trend for every canvas, plus KV, file, AI, and realtime usage once the backend is on.",
  },
];

/** "Built for teams": admin & control capabilities. */
const TEAM: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Teams & invites",
    body: "Group people into a team and grant it on any canvas, as viewers or as editors. Add colleagues by email before they have ever signed in; access materializes on their first login through your auth. Inviting people from outside your domain is an admin's call, or a policy admins can hand to members.",
  },
  {
    title: "Editors & ownership",
    body: "Give a person or a team the editor role and they can do everything the owner can, except delete the canvas, transfer it, or switch on guest AI. Org members only, re-checked on every request. Owners hand a canvas to an editor from the people list; admins reassign the canvases of anyone who leaves.",
  },
  {
    title: "Org sign-in (SSO)",
    body: "Everyone signs in through your OIDC provider or behind your identity-aware proxy. Access is gated by email domain and an admin allowlist, and canvas-drop holds no user passwords.",
  },
  {
    title: "Admin console",
    body: "Set AI spend quotas and defaults, switch public links on or off instance-wide, and choose which members may publish them. Disable any canvas with a stated reason and re-enable it later.",
  },
  {
    title: "Your brand, your look",
    body: "Switch the whole instance, dashboard, editor, and this page included, to one of four design skins from the admin console. No restart, no code.",
  },
  {
    title: "Member management",
    body: "See who's in, grant or revoke admin, and block access in a click.",
  },
  {
    title: "Audit log",
    body: "Sign-ins, deploys, publishes, sharing changes, and admin actions are recorded in an audit table in your database. Query it with the tools you already have.",
  },
];

/** "Restricted by default": the privacy / security posture. */
const PRIVACY: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Restricted by default",
    body: "Every canvas starts Restricted: only its owner and the people or teams they add can open it until they choose a wider rung.",
  },
  {
    title: "No telemetry, ever",
    body: "canvas-drop never phones home. No tracking, no analytics, no third-party beacons; even the fonts are served from your instance.",
  },
  {
    title: "Secrets stay server-side",
    body: "AI provider keys and canvas deploy keys live on the server. Canvas code ships no secrets, and identity comes from the server, never from the client.",
  },
  {
    title: "Backend off by default",
    body: "A canvas reaches no backend until you switch it on, and you choose which primitives it may use. Public visitors get static files only.",
  },
  {
    title: "Your infrastructure",
    body: "Self-host on a single VPS or your own cloud. Your data lives where you put it, and the only outbound calls are the ones you configure, such as an AI provider.",
  },
];

/**
 * Full document `<head>`: title, description, canonical, Open Graph + Twitter
 * card, theme-color, and JSON-LD. The OG/Twitter image is the shared `/og.png`
 * card (absolute URL; crawlers require it). Unlike the gated surfaces this page
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
<style>${STYLES}
</style>
${SITE_THEME_SCRIPT}`;
}

/**
 * All page CSS. The semantic colour ramp comes from the canonical `BRAND_TOKENS`
 * (`@canvas-drop/shared`, via `rampCssVars()`), the SAME source the dashboard and
 * every other server surface use, so the landing can't drift (the old hand-forked
 * ramp is gone). Landing-only chrome vars (--ink/--on-ink hero band, shadows,
 * easing, max width) are layered on top.
 */
const STYLES = `${SITE_STYLES}\n${LANDING_LAYOUT}`;

const ghIcon = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.65.35-1.1.63-1.35-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>`;
const arrow = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// The screenshot assets are served with a 1-day cache under a STABLE filename, so a
// refreshed shot (e.g. `pnpm landing:screenshots`) would otherwise stay stale in
// browser/CDN caches for up to a day. Append a short content hash so a changed image
// busts caches immediately while an unchanged one keeps caching. Resolved from the same
// committed dir the docs route serves (apps/server/src|dist/http → ../../../.. = repo root).
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../..", "docs/site/assets");
const assetVerCache = new Map<string, string>();
function assetSrc(img: string): string {
  let ver = assetVerCache.get(img);
  if (ver === undefined) {
    try {
      ver = createHash("sha256")
        .update(readFileSync(join(ASSETS_DIR, `${img}.webp`)))
        .digest("hex")
        .slice(0, 8);
    } catch {
      ver = ""; // asset unreadable (shouldn't happen in a real deploy) → no cache-bust
    }
    assetVerCache.set(img, ver);
  }
  return ver ? `/docs/assets/${img}.webp?v=${ver}` : `/docs/assets/${img}.webp`;
}

/** One carousel slide: a framed dark screenshot + a caption. */
function tourSlide(t: (typeof TOUR)[number]): string {
  return `<figure class="slide">
  <div class="shot"><img src="${assetSrc(t.img)}" width="1440" height="900" alt="${escapeHtml(`${t.label}. ${t.caption}`)}" loading="lazy" decoding="async"></div>
  <figcaption><strong>${escapeHtml(t.label)}.</strong> ${escapeHtml(t.caption)}</figcaption>
</figure>`;
}

/** Details keep the main story short while preserving capability information. */
function featItem(f: { title: string; body: string }): string {
  return `<details class="feat"><summary>${escapeHtml(f.title)}</summary><p>${escapeHtml(f.body)}</p></details>`;
}

/** One rung of the sharing-ladder marketing visual. */
function ladderRung(r: (typeof LADDER)[number], i: number): string {
  const tag = r.tag ? ` <span class="r-tag">${escapeHtml(r.tag)}</span>` : "";
  return `<div class="rung${r.feature ? " feature" : ""}">
  <span class="r-step">${i + 1}</span>
  <div><span class="r-name">${escapeHtml(r.rung)}${tag}</span><p class="r-who">${escapeHtml(r.who)}</p></div>
</div>`;
}

function capabilityCard(p: (typeof BACKEND_CAPABILITIES)[number]): string {
  const paint = p.glyphFill
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  return `<div class="prim p-${escapeHtml(p.tag)}">
  <div class="ic"><svg viewBox="${p.viewBox ?? "0 0 24 24"}" aria-hidden="true"><path d="${p.glyph}" ${paint}/></svg></div>
  <h4>${escapeHtml(p.name)} <span class="tag mono">${escapeHtml(p.tag)}</span></h4>
  <p>${escapeHtml(p.blurb)}</p>
</div>`;
}

/** Render the full landing page HTML. `origin` is `config.baseUrl` (for absolute OG URLs). */
export function renderLandingPage(
  origin = "",
  authMode: Config["auth"]["mode"] = "oidc",
  signedIn = false,
  skin: SkinName = "editorial",
): string {
  // Primary CTA target. A signed-in viewer (only possible on the always-public
  // `/welcome` alias. `/` only renders this page when signed out) gets a direct
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
      `<div class="value"><span class="num">0${i + 1}</span><h3>${escapeHtml(v.title)}</h3><p>${escapeHtml(v.body)}</p></div>`,
  ).join("\n");

  // editorial is the attribute-free base (matches the SPA's applySkin, which removes the
  // attribute for editorial). Only the alternates stamp data-skin, so there's no surface
  // divergence and no [data-skin="editorial"] rule is ever needed. The tag + the override
  // CSS both come from the shared skin-html helper, so the landing can't drift from docs/legal.
  return `<!doctype html>
${skinnedHtmlTag(skin)}
<head>
${head(origin)}
</head>
<body>
${siteHeader({ action: { href: cta.href, label: cta.short } })}
<main id="main-content" tabindex="-1">
  <section class="hero" aria-label="Introducing canvas-drop">
    <div class="wrap hero-inner">
      <div class="hero-copy">
        <span class="eyebrow">${escapeHtml(SITE.eyebrow)}</span>
        <h1>Drop it in.<br><span class="accent">Share it out.</span></h1>
      </div>
      <div class="hero-description">
        <p class="lede">${escapeHtml(SITE.subhead)}</p>
        <div class="cta-row"><a class="btn btn-primary" href="${cta.href}">${cta.label} ${arrow}</a><a class="btn btn-ghost" href="#how-it-works">How it works</a></div>
        <p class="cue">Bring your files, or <a href="/docs/agents/mcp">connect your agent over MCP.</a></p>
      </div>
    </div>
  </section>
  <section class="tour wrap" aria-label="Product walkthrough">
    <h2 class="s-head">From an artifact to a tool your team can use.</h2>
    <p class="s-sub">A shared home, controlled access, and a way to keep improving what you made.</p>
    <div class="carousel" data-embla aria-roledescription="carousel" aria-label="Product tour">
      <div class="viewport" data-embla-viewport tabindex="0" role="region" aria-label="Product screens"><div class="embla-container">${TOUR.map(tourSlide).join("\n")}</div></div>
      <div class="tour-controls" data-embla-controls hidden>
        <button class="btn btn-outline" type="button" data-embla-prev aria-label="Previous screen">Previous</button>
        <div class="dots" role="group" aria-label="Choose screen">${TOUR.map((t, i) => `<button class="dot" type="button" data-embla-dot aria-label="${escapeHtml(t.label)}"${i === 0 ? ' aria-current="true"' : ""}></button>`).join("\n")}</div>
        <button class="btn btn-outline" type="button" data-embla-next aria-label="Next screen">Next</button>
      </div>
    </div>
    <p class="tour-note">Product walkthrough with example content, shown in the Editorial skin.</p>
  </section>
  <section class="section" id="how-it-works" aria-label="From files to a shared canvas"><div class="wrap values">${values}</div></section>
  <section class="section section-tint">
    <div class="wrap split">
      <div><p class="kicker">Sharing</p><h2 class="s-head">A working link.<br>The right people.</h2><p class="s-sub">An access ladder that fits how people actually share. The people and teams you name always get in. General access says who else does.</p><p class="ladder-note"><strong>Add people by email</strong>, even before their first sign-in. They enter through your instance’s auth: no app-managed passwords, no magic-link accounts. Inviting someone from outside your domain follows your admin’s policy.</p></div>
      <div class="ladder">${LADDER.map(ladderRung).join("\n")}</div>
    </div>
  </section>
  <section class="section">
    <div class="wrap"><p class="kicker">Six primitives + authoring</p><h2 class="s-head">Let it do more.</h2><p class="s-sub">Keep shared data, respond to people, and connect to approved services. Static files first, with no server build. Six runtime primitives add data, files, AI, identity, realtime, and controlled access to third-party APIs through admin-granted Connections. The separately gated authoring capability lets signed-in viewers publish canvases as themselves. Secrets stay server-side.</p><div class="prims">${BACKEND_CAPABILITIES.map(capabilityCard).join("\n")}</div></div>
  </section>
  <section class="section section-tint">
    <div class="wrap split">
      <div><p class="kicker">Built for teams</p><h2 class="s-head">A small tool.<br>A proper home.</h2><p class="s-sub">Your sign-in, your workspace, your rules. Give colleagues room to build, with the controls your organization needs.</p><div class="feats">${TEAM.map(featItem).join("\n")}</div></div>
      <div><p class="kicker">Restricted by default</p><h2 class="s-head">Yours to run.<br>Yours to trust.</h2><p class="s-sub">Open source under the MIT license. Self-host with Docker on a VPS or your own cloud. SQLite or Postgres, local disk or S3: each a config change.</p><div class="feats">${PRIVACY.map(featItem).join("\n")}</div><div class="cta-row"><a class="btn btn-outline" href="${escapeHtml(SITE.githubUrl)}" target="_blank" rel="noopener noreferrer">${ghIcon} View on GitHub</a><a class="btn btn-outline" href="/docs">Self-host guide ${arrow}</a></div></div>
    </div>
  </section>
</main>
${siteFooter()}
<script src="/docs/assets/landing-carousel.js" defer></script>
</body>
</html>`;
}

/**
 * Front-door gate: render the marketing landing for a signed-out `GET /`, but
 * step aside for everything else so the request continues to the auth gateway +
 * dashboard SPA. Mounted BEFORE `socialPreview` and the gateway in `app.ts`.
 *
 * Only active in `oidc` mode. `proxy` mode is IAP-fronted (a signed-out request
 * never reaches the app) and `dev` mode is always signed in (so `/` is the SPA).
 * A signed-in visitor is detected by the mere PRESENCE of the session cookie (a
 * cheap check, mirroring `socialPreview`): present → fall through so the gateway
 * resolves it and serves the dashboard. We deliberately do NOT call
 * `resolveIdentity` here. In oidc mode that slides the session (a DB write + a
 * fresh `Set-Cookie`), and the gateway re-resolves anyway, so peeking would double
 * the work and emit two `Set-Cookie`s on the hottest authed path. An expired
 * cookie still falls through and the gateway redirects to login. Never worse.
 */
export function landingGate(deps: { config: Config; skin?: () => Promise<SkinName> }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (deps.config.auth.mode !== "oidc") return next();
    if (c.req.path !== "/") return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    // A guest/public principal (U7) is a real canvas visitor, not a front-door hit.
    if (c.get("principal")) return next();
    // A session cookie → (possibly) signed-in human → let the gateway serve the SPA.
    if (getCookie(c, SESSION_COOKIE)) return next();
    // Only the BASE host has a marketing front door. On a canvas subdomain, `/` is the
    // canvas root. Falling through lets social-preview/the gateway redirect to login
    // carrying a returnTo, so a signed-out visitor lands back on the canvas after
    // sign-in instead of on the generic welcome page (which has no returnTo CTA).
    const { role } = resolveRequest(
      { host: c.req.header("host") ?? "", pathname: c.req.path },
      deps.config,
    );
    if (role === "canvas") return next();
    return landingResponse(deps.config, deps.skin ? { skin: await deps.skin() } : {});
  });
}

/**
 * HTML response for the landing page. `signedIn` (cookie-presence on the
 * always-public `/welcome` alias) swaps the CTA to "Open dashboard" so a signed-in
 * member is never sent to a re-login. The CTA varies by session, so the response
 * is `private` + `Vary: Cookie`. A shared/CDN cache must never serve one auth
 * state's page to the other.
 */
export function landingResponse(
  config: Config,
  opts: { signedIn?: boolean; skin?: SkinName } = {},
): Response {
  const headers = new Headers();
  baseSecurityHeaders(headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  // Inline styles and JSON-LD; the product-tour controller is served same-origin.
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("Vary", "Cookie");
  return new Response(
    renderLandingPage(
      config.baseUrl,
      config.auth.mode,
      opts.signedIn ?? false,
      opts.skin ?? config.designSkin,
    ),
    {
      status: 200,
      headers,
    },
  );
}

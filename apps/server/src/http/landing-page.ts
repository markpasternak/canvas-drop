import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND_TOKENS, type Config, oklchToHex, type SkinName } from "@canvas-drop/shared";
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
  tagline: "Publish what you make with AI as a canvas for your team.",
  /** Big headline. Two short clauses read well at display scale. */
  headline: "Make it with AI. Share it as a canvas.",
  /** Sub-headline beneath the H1. */
  subhead:
    "Give your report, prototype, or app a stable link your team can open through your organization’s sign-in. Each canvas is a live web page or app, with named viewers and editors and a history of published versions.",
  /** Open-source project URL. */
  githubUrl: "https://github.com/markpasternak/canvas-drop",
  /** SEO/meta description (plain text, ≤ ~160 chars). */
  metaDescription:
    "Publish web tools as canvases with stable links, organization sign-in and version history. Open source and self-hosted, with MCP for your AI agent.",
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
    name: "Data storage",
    tag: "kv",
    blurb:
      "Save shared data and each viewer’s preferences. Group authored records into collections with their own permissions.",
    glyph: "M4 7h16M4 12h16M4 17h10",
  },
  {
    name: "Files",
    tag: "files",
    blurb:
      "Let people upload files to a canvas. Set who can read or change them; attachments follow their parent record’s access.",
    glyph: "M6 3h8l4 4v14H6zM14 3v4h4",
  },
  {
    name: "AI",
    tag: "ai",
    blurb:
      "Add AI responses using your configured models and quotas. Provider keys stay on the server.",
    glyph: "M12 3v4M12 17v4M3 12h4M17 12h4M7 7l2 2M15 15l2 2M17 7l-2 2M9 15l-2 2",
  },
  {
    name: "Identity",
    tag: "identity",
    blurb:
      "Use each viewer’s signed-in identity, canvas role and permissions. The server resolves who they are.",
    glyph: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M5 20a7 7 0 0 1 14 0",
  },
  {
    name: "Realtime",
    tag: "realtime",
    blurb:
      "Add live messages and presence. Choose who can receive, publish and appear in each channel.",
    glyph: "M5 12a7 7 0 0 1 14 0M8 12a4 4 0 0 1 8 0M12 12h.01",
  },
  {
    name: "Connections",
    tag: "connections",
    blurb:
      "Call approved third-party APIs through admin-granted Connections. Credentials stay on the server.",
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
    title: "Let your agent publish the canvas",
    body: "Bring HTML or files from an AI chat, cloud workspace, or laptop. Your agent can create and update canvases over MCP with the same permissions you have in the dashboard.",
  },
  {
    title: "Keep the link as your canvas changes",
    body: "Work on a draft while colleagues use the published canvas. Preview and publish updates at the same URL, or make an earlier version current again.",
  },
  {
    title: "Use your organization’s sign-in",
    body: "Give people and teams viewer or editor access to each canvas. Open it to your whole organization, or publish a public link when your admin allows it.",
  },
];

/** The per-canvas access ladder (the sharing model, plan 003). Rendered as a marketing
 *  visual. The landing is the widest-reaching surface for the team + invite story. Order
 *  reads top-down the way the Share tab does: the people-and-teams list first (it always
 *  applies), then the three General-access choices (Restricted → Whole org → Public link). */
const LADDER: ReadonlyArray<{ rung: string; who: string; tag?: string; feature?: boolean }> = [
  {
    rung: "People & teams",
    who: "Add colleagues and teams as viewers or editors. Their access stays in place whichever option you choose below.",
    feature: true,
  },
  { rung: "Restricted", who: "Nobody else. With no one added, that's just you." },
  { rung: "Whole org", who: "Anyone signed in to your organization." },
  {
    rung: "Public link",
    who: "Anyone with the URL, subject to any password or expiry you set. Available when your admin allows it.",
    tag: "admin-controlled",
  },
];

/** Product-tour carousel slides → committed light screenshots at /docs/assets.
 *  Refresh with `pnpm landing:screenshots` (after `pnpm seed:canvases`). */
const TOUR: ReadonlyArray<{ img: string; label: string; title: string; caption: string }> = [
  {
    img: "landing-dashboard",
    label: "Your workspace",
    title: "Keep your canvases within reach.",
    caption:
      "Find the canvases you own or help edit. Open a published tool, continue a draft, or start your next canvas from HTML or uploaded files.",
  },
  {
    img: "tour-editor",
    label: "Edit & publish",
    title: "Improve the canvas. Keep its link.",
    caption:
      "Edit an autosaved draft while the published canvas stays available. Preview your changes, review what will go live, and publish when ready.",
  },
  {
    img: "tour-sharing",
    label: "Links & access",
    title: "Choose who can open your canvas.",
    caption:
      "Start Restricted, then open the canvas to your organization or use a public link when your admin allows it. Set a password or expiry when a share needs one.",
  },
  {
    img: "tour-people",
    label: "People & editors",
    title: "Invite colleagues to improve the canvas.",
    caption:
      "Give named people and teams viewer or editor access. Editors can change files and publish updates; the owner controls ownership and deletion.",
  },
  {
    img: "tour-capabilities",
    label: "Data & capabilities",
    title: "Add data and AI to your canvas.",
    caption:
      "Enable the backend features your canvas needs, from saved data to AI responses and live collaboration. Admin-granted Connections let it call approved services with credentials kept on the server.",
  },
  {
    img: "tour-shared",
    label: "Shared with you",
    title: "Find the canvases shared with you.",
    caption:
      "Return to canvases shared directly with you or your teams, plus those listed for your organization. Search by name or filter by owner.",
  },
  {
    img: "landing-gallery",
    label: "Gallery & templates",
    title: "Make a useful canvas your starting point.",
    caption:
      "Explore canvases their owners chose to list in the gallery. Clone a template into your own canvas, then adapt the files and publish your version.",
  },
  {
    img: "tour-usage",
    label: "Usage",
    title: "See which canvases people use.",
    caption:
      "Review views, unique viewers and recent activity for each canvas. Check backend usage as well, including storage and AI calls.",
  },
  {
    img: "tour-teams",
    label: "Teams & invites",
    title: "Give a team access to the canvases it needs.",
    caption:
      "Manage membership in one team, then grant that team access to individual canvases. Invite colleagues by email; they join through your organization’s sign-in.",
  },
  {
    img: "tour-admin",
    label: "Administration",
    title: "Manage canvases across your organization.",
    caption:
      "Find canvases by owner, access and status. Inspect permissions, hand over ownership, and review the exact selection before an administrative action.",
  },
  {
    img: "tour-preview",
    label: "Preview covers",
    title: "Make each canvas easy to recognize.",
    caption:
      "Use an automatic screenshot when capture is enabled, or upload a cover that stays with future versions. You can also turn previews off.",
  },
];

/** "Built for teams": admin & control capabilities. */
const TEAM: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Teams & invites",
    body: "Share with a team as viewers or editors. Invite colleagues by email before their first sign-in. Your admin decides whether people outside your organization can be invited.",
  },
  {
    title: "Editors & ownership",
    body: "Editors help manage, edit, and publish a canvas. Deletion, ownership transfer, and enabling guest AI remain owner-only. Owners can hand work to an editor; admins can reassign it when someone leaves.",
  },
  {
    title: "Org sign-in (SSO)",
    body: "Use your OIDC provider or identity-aware proxy, with your allowed domains and people. Canvas Drop does not manage user passwords.",
  },
  {
    title: "Admin console",
    body: "Filter by owner, access, or status and save useful views. Inspect ownership and permissions without gaining access to private canvas content.",
  },
  {
    title: "Your brand, your look",
    body: "Choose from four design skins for your dashboard, editor, and public pages. Change the whole instance from the admin console without a restart.",
  },
  {
    title: "A clear handover",
    body: "Preview a departing person's canvases and access. Reassign ownership, block the account, revoke sessions and agent tokens, and see exactly what still needs follow-up.",
  },
  {
    title: "Investigate and act",
    body: "Check why someone has access, review administrative activity, and preview bulk actions. Restore deleted work during retention or purge it afterward; backups follow their own policy.",
  },
  {
    title: "Connections you can operate",
    body: "See recent failures, latency, and affected canvases. Test a connection and rotate its credentials while their values stay on the server.",
  },
];

/** "Restricted by default": the privacy / security posture. */
const PRIVACY: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Restricted by default",
    body: "New canvases start Restricted. Only the owner and the people or teams they add can open them until access is widened.",
  },
  {
    title: "Usage stays in your instance",
    body: "Canvas Drop does not phone home or load third-party tracking. Product usage data stays in your instance, and fonts are served locally.",
  },
  {
    title: "Secrets stay server-side",
    body: "Built-in AI and Connections keep provider credentials on the server. The backend resolves each visitor’s identity and permissions for every request.",
  },
  {
    title: "Backend off by default",
    body: "You choose which backend capabilities a canvas may use. Named collections, file groups, channels, and Connections each have their own permission controls.",
  },
  {
    title: "Your infrastructure",
    body: "Choose SQLite or Postgres and local disk or S3 for your canvas files and data. Configured AI providers and Connections use the external services you choose.",
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
<meta name="theme-color" content="${oklchToHex(BRAND_TOKENS.dark.canvas)}" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="${oklchToHex(BRAND_TOKENS.light.canvas)}" media="(prefers-color-scheme: light)">
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
function assetFileSrc(filename: string): string {
  let ver = assetVerCache.get(filename);
  if (ver === undefined) {
    try {
      ver = createHash("sha256")
        .update(readFileSync(join(ASSETS_DIR, filename)))
        .digest("hex")
        .slice(0, 8);
    } catch {
      ver = ""; // asset unreadable (shouldn't happen in a real deploy) → no cache-bust
    }
    assetVerCache.set(filename, ver);
  }
  return ver ? `/docs/assets/${filename}?v=${ver}` : `/docs/assets/${filename}`;
}

function assetSrc(img: string): string {
  return assetFileSrc(`${img}.webp`);
}

/** A complete, readable slide also works with native horizontal scrolling and no JavaScript. */
function tourSlide(t: (typeof TOUR)[number], index: number): string {
  return `<figure class="slide" id="tour-screen-${index + 1}" role="group" aria-roledescription="slide" aria-label="${index + 1} of ${TOUR.length}: ${escapeHtml(t.label)}">
  <figcaption class="tour-caption">
    <h3>${escapeHtml(t.title)}</h3>
    <p>${escapeHtml(t.caption)}</p>
    <a class="text-link" href="${assetSrc(t.img)}" target="_blank" rel="noopener">View full-size screenshot <span class="sr-only">of ${escapeHtml(t.label)} (opens in a new tab)</span>${arrow}</a>
  </figcaption>
  <div class="shot"><img src="${assetSrc(t.img)}" width="2560" height="1600" alt="Canvas-drop: ${escapeHtml(t.label)}" loading="${index === 0 ? "eager" : "lazy"}"${index === 0 ? ' fetchpriority="high"' : ""} decoding="async"></div>
</figure>`;
}

/** Details keep the main story short while preserving capability information. */
function featItem(f: { title: string; body: string }): string {
  return `<details class="feat"><summary>${escapeHtml(f.title)}</summary><p>${escapeHtml(f.body)}</p></details>`;
}

/** One rung of the sharing-ladder marketing visual. */
function ladderRung(r: (typeof LADDER)[number]): string {
  const tag = r.tag ? ` <span class="r-tag">${escapeHtml(r.tag)}</span>` : "";
  return `<div class="rung${r.feature ? " feature" : ""}">
  <div><span class="r-name">${escapeHtml(r.rung)}${tag}</span><p class="r-who">${escapeHtml(r.who)}</p></div>
</div>`;
}

function capabilityCard(p: (typeof BACKEND_CAPABILITIES)[number]): string {
  const paint = p.glyphFill
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  return `<div class="prim p-${escapeHtml(p.tag)}">
  <div class="ic"><svg viewBox="${p.viewBox ?? "0 0 24 24"}" aria-hidden="true"><path d="${p.glyph}" ${paint}/></svg></div>
  <h3>${escapeHtml(p.name)}</h3>
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
    (v) => `<div class="value"><h3>${escapeHtml(v.title)}</h3><p>${escapeHtml(v.body)}</p></div>`,
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
        <h1>Make it with AI.<br><span class="accent">Share it as a canvas.</span></h1>
      </div>
      <div class="hero-description">
        <p class="lede">${escapeHtml(SITE.subhead)}</p>
        <div class="cta-row"><a class="btn btn-primary" href="${cta.href}">${cta.label} ${arrow}</a><a class="btn btn-ghost" href="/docs/self-hosting/install">Set up your instance</a></div>
        <p class="cue">Self-hosted and MIT licensed. <a href="/docs/agents/mcp">Connect your AI agent.</a></p>
      </div>
    </div>
  </section>
  <section class="tour wrap" aria-label="Product walkthrough">
    <div class="carousel" data-embla aria-roledescription="carousel" aria-label="Product tour">
      <div class="tour-heading">
        <h2>See what your canvas can become.</h2>
        <div class="tour-controls" data-embla-controls hidden>
          <div class="tour-picker"><span id="tour-picker-label">Explore</span>
            <select aria-label="Choose walkthrough topic" data-embla-select>${TOUR.map((t, i) => `<option value="${i}">${escapeHtml(t.label)}</option>`).join("")}</select>
            <div class="tour-topic" data-tour-picker hidden>
              <button class="tour-topic-trigger" type="button" role="combobox" aria-label="Choose walkthrough topic" aria-expanded="false" aria-haspopup="listbox" aria-controls="tour-topics" data-tour-trigger><span data-tour-value>${escapeHtml(TOUR[0]?.label ?? "Your workspace")}</span><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m6 8 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
              <ul class="tour-topic-menu" id="tour-topics" role="listbox" aria-label="Walkthrough topics" data-tour-list hidden>${TOUR.map((t, i) => `<li class="tour-topic-option" id="tour-topic-${i}" role="option" aria-selected="${i === 0}" data-tour-option><span>${escapeHtml(t.label)}</span><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 10 3 3 7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></li>`).join("")}</ul>
            </div>
          </div>
          <div class="tour-pagination">
            <span class="tour-count" data-embla-count aria-live="polite" aria-atomic="true">1 / ${TOUR.length}</span>
            <button class="tour-arrow" type="button" data-embla-prev aria-label="Previous screen">${arrow}</button>
            <button class="tour-arrow" type="button" data-embla-next aria-label="Next screen">${arrow}</button>
          </div>
        </div>
      </div>
      <div class="viewport" data-embla-viewport tabindex="0" role="region" aria-label="Product screens" aria-describedby="tour-instructions"><div class="embla-container">${TOUR.map(tourSlide).join("\n")}</div></div>
      <p id="tour-instructions" class="tour-note"><span data-embla-instructions>Scroll sideways to explore.</span> Actual product screens with example content, shown in the Editorial skin.</p>
    </div>
  </section>
  <section class="section" id="how-it-works" aria-label="From files to a shared canvas"><div class="wrap values">${values}</div></section>
  <section class="section section-tint">
    <div class="wrap split">
      <div><h2 class="s-head">Choose who can use<br>and edit your canvas.</h2><p class="s-sub">Start with the people and teams who need your canvas. Add them as viewers or editors, then decide whether to open it to your whole organization or anyone with the link.</p><p class="ladder-note">The people and teams you add keep their access when you change General access. Invite colleagues before their first visit; they use your organization’s sign-in, with no separate password to manage.</p><a class="text-link section-link" href="/docs/authoring/sharing">How canvas sharing works ${arrow}</a></div>
      <div class="ladder">${LADDER.map(ladderRung).join("\n")}</div>
    </div>
  </section>
  <section class="section">
    <div class="wrap"><h2 class="s-head">Give your canvas<br>the backend it needs.</h2><p class="s-sub">Six built-in capabilities let your canvas save data, accept uploads, call AI and work live with other people. Use them through the browser SDK after enabling access; authoring is a separate opt-in.</p><div class="prims">${BACKEND_CAPABILITIES.map(capabilityCard).join("\n")}</div></div>
  </section>
  <section class="section section-tint">
    <div class="wrap split">
      <div><h2 class="s-head">Make room for canvases<br>across your organization.</h2><p class="s-sub">Use the sign-in your organization already has. Keep ownership clear, review access, and hand over canvases when people change roles.</p><div class="feats">${TEAM.map(featItem).join("\n")}</div></div>
      <div><h2 class="s-head">Run Canvas Drop<br>on your infrastructure.</h2><p class="s-sub">The source is yours under the MIT license. Run the Docker image on a VPS or in your cloud, with your choice of database and file storage.</p><div class="feats">${PRIVACY.map(featItem).join("\n")}</div><div class="cta-row"><a class="btn btn-outline" href="${escapeHtml(SITE.githubUrl)}" target="_blank" rel="noopener noreferrer">${ghIcon} View on GitHub</a><a class="btn btn-outline" href="/docs/self-hosting/install">Self-host guide ${arrow}</a></div></div>
    </div>
  </section>
  <section class="section closing"><div class="wrap closing-inner"><div><h2 class="s-head">Make your next creation<br>a canvas people use.</h2><p class="s-sub">Bring your HTML or files, or connect your AI agent. Publish a canvas and share its link with your team.</p></div><div class="cta-row"><a class="btn btn-primary" href="${cta.href}">${cta.label} ${arrow}</a><a class="text-link" href="/docs/authoring/create-and-publish">Create your first canvas ${arrow}</a></div></div></section>
</main>
${siteFooter()}
<script src="${assetFileSrc("landing-carousel.js")}" defer></script>
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

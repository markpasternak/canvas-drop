import type { Config, SkinName } from "@canvas-drop/shared";
import { Hono } from "hono";
import { escapeAttribute, escapeHtml } from "./error-pages.js";
import { baseSecurityHeaders } from "./security-headers.js";
import { SITE_STYLES, SITE_THEME_SCRIPT, siteFooter, siteHeader } from "./site-chrome.js";
import { skinnedHtmlTag } from "./skin-html.js";
import { FAVICON_LINKS, ogMeta } from "./social-meta.js";
import type { AppEnv } from "./types.js";

/**
 * Public legal pages — Privacy Policy (`/privacy`) and Terms of Service
 * (`/terms`).
 *
 * These exist primarily for the Google OAuth consent screen, which requires a
 * publicly reachable privacy-policy and terms URL that its reviewers can open
 * **while signed out**. So this router is mounted BEFORE the auth gateway in
 * `app.ts` (next to `/healthz` and `/auth`); everything below the gateway needs
 * an org session and would bounce Google's crawler to a login redirect.
 *
 * The documents use the shared public-page chrome and optional theme client,
 * with no SPA bundle. Content is hardcoded for
 * the canvas-drop.com instance (operator, contact, jurisdiction) and describes
 * only the data this codebase actually handles.
 */

/** Operator-specific facts baked into the canvas-drop.com legal pages. */
const OPERATOR = {
  name: "canvas-drop (canvas-drop.com)",
  contactEmail: "mark.pasternak@gmail.com",
  jurisdiction: "Sweden",
  /** Human-readable "last updated" stamp shown at the top of each document. */
  lastUpdated: "14 June 2026",
} as const;

/**
 * `opts.skin` resolves the effective instance design skin per-request (admin DB
 * override over env/default), threaded in from `app.ts` like the landing + docs
 * surfaces, so the legal pages wear the active skin too. Default editorial when no
 * resolver is supplied.
 */
export function legalRoutes(
  config: Config,
  opts: { skin?: () => Promise<SkinName> } = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const origin = config.baseUrl;
  const resolveSkin = opts.skin ?? (async () => "editorial" as const);
  app.get("/privacy", async () => htmlResponse(renderPrivacyPage(origin, await resolveSkin())));
  app.get("/terms", async () => htmlResponse(renderTermsPage(origin, await resolveSkin())));
  return app;
}

function htmlResponse(html: string): Response {
  const headers = new Headers();
  baseSecurityHeaders(headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  // Public, cacheable legal text. Allow indexing (no `noindex`) so the policies
  // are discoverable; lock down framing like the other self-rendered surfaces.
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(html, { status: 200, headers });
}

/** SEO + Open Graph + Twitter tags via the shared {@link ogMeta} builder, so the
 *  legal pages unfurl identically to the landing + docs. The title is suffixed
 *  with the brand; the page shares the public-site theme controls. */
function socialMeta(path: string, title: string, description: string, origin: string): string {
  return ogMeta({ origin, path, title: `${title} · canvas-drop`, description });
}

/** Shared minimal flat page chrome (logo + wordmark, serif title, body), warm-paper
 *  light with a graphite dark alternate — matching the brand token ramp. */
function renderLegalPage(opts: {
  title: string;
  intro: string;
  body: string;
  path: string;
  origin: string;
  skin: SkinName;
}): string {
  return `<!doctype html>
${skinnedHtmlTag(opts.skin)}
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} · canvas-drop</title>
${socialMeta(opts.path, opts.title, opts.intro, opts.origin)}
${FAVICON_LINKS}
${SITE_THEME_SCRIPT}
<style>
${SITE_STYLES}
.legal-content { width: min(100%, 49rem); margin: 0 auto; padding: clamp(2rem, 5vw, 4rem) clamp(1.25rem, 5vw, 2.5rem) 4rem; }
.legal-nav { display: flex; gap: 1.5rem; border-bottom: 1px solid var(--border); margin-bottom: 2.5rem; }
.legal-nav a { display: inline-flex; align-items: center; min-height: 44px; padding-block: .5rem; color: var(--muted); text-decoration: none; font-size: .875rem; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.legal-nav a[aria-current="page"] { border-color: var(--accent); color: var(--fg); font-weight: 600; }
.legal-content h1, .legal-content h2 { font-family: var(--font-display); font-optical-sizing: auto; font-weight: var(--display-weight); letter-spacing: var(--display-tracking); text-wrap: balance; }
.legal-content h1 { font-size: clamp(2.5rem, 6vw, 3.5rem); line-height: 1.08; margin: 0 0 .75rem; }
.legal-content h2 { font-size: 1.5rem; line-height: 1.25; margin: 2.5rem 0 .7rem; }
.legal-content .updated { color: var(--muted); font-size: .8125rem; margin: 0 0 1.75rem; }
.legal-content .intro { font-size: 1.125rem; color: var(--muted); margin: 0 0 2.5rem; padding-bottom: 2rem; border-bottom: 1px solid var(--border); }
.legal-content p, .legal-content li { color: var(--muted); overflow-wrap: anywhere; }
.legal-content p { margin: .75rem 0; }
.legal-content ul { margin: .75rem 0; padding-left: 1.25rem; }
.legal-content li { margin-block: .65rem; padding-left: .25rem; }
.legal-content strong { color: var(--fg); font-weight: 600; }
.legal-content p a { color: var(--accent); text-underline-offset: .2em; }
.legal-content a:hover { text-decoration: underline; }
</style>
</head>
<body>
  ${siteHeader()}
  <main class="legal-content" id="main-content" tabindex="-1">
    <nav class="legal-nav" aria-label="Legal">
      <a href="/privacy"${opts.path === "/privacy" ? ' aria-current="page"' : ""}>Privacy Policy</a>
      <a href="/terms"${opts.path === "/terms" ? ' aria-current="page"' : ""}>Terms of Service</a>
    </nav>
    <h1>${escapeHtml(opts.title)}</h1>
    <p class="updated">Last updated ${escapeHtml(OPERATOR.lastUpdated)}</p>
    <p class="intro">${opts.intro}</p>
    ${opts.body}
  </main>
  ${siteFooter(opts.path === "/privacy" ? "/privacy" : "/terms")}
</body>
</html>`;
}

const CONTACT_LINK = `<a href="mailto:${escapeAttribute(OPERATOR.contactEmail)}">${escapeHtml(OPERATOR.contactEmail)}</a>`;

export function renderPrivacyPage(origin = "", skin: SkinName = "editorial"): string {
  const body = `
    <h2>Who we are</h2>
    <p>${escapeHtml(OPERATOR.name)} ("canvas-drop", "we", "us") operates this instance and is the data
    controller for the information described below. canvas-drop is open-source software (MIT);
    this policy covers the instance hosted at canvas-drop.com.</p>

    <h2>What we collect</h2>
    <ul>
      <li><strong>Account identity.</strong> When you sign in with Google, we receive your
      name, email address, and profile-picture URL from your identity provider to identify you
      and control access.</li>
      <li><strong>Session.</strong> A single essential cookie that keeps you signed in. We use no
      tracking or advertising cookies.</li>
      <li><strong>Content you create.</strong> The canvases you deploy or store — their files,
      code, and any key-value data your canvases save.</li>
      <li><strong>Usage and security logs.</strong> An audit log of significant actions, AI-usage
      records (only if AI features are enabled and you use them), and your IP address, used
      transiently for rate-limiting and abuse prevention.</li>
    </ul>

    <h2>How we use it</h2>
    <p>Solely to provide and operate the service: to authenticate you, enforce access, serve the
    canvases you create, and keep the platform secure. We do not sell your data, show ads, or run
    third-party analytics or phone-home telemetry.</p>

    <h2>Who we share it with</h2>
    <ul>
      <li><strong>Your sign-in provider (Google).</strong> Authentication happens through Google;
      their handling of your sign-in is governed by Google's own privacy policy.</li>
      <li><strong>AI provider.</strong> Only if AI features are enabled and you use them, the
      prompts you send are forwarded to the configured AI provider (Anthropic) to generate
      responses.</li>
      <li><strong>Hosting infrastructure.</strong> Our hosting and storage providers process data
      on our behalf to run the service.</li>
    </ul>

    <h2>Retention</h2>
    <p>We keep your identity and content for as long as your account and canvases exist. Deleting a
    canvas or your account removes the associated data. Security and audit logs are kept for a
    limited period for abuse prevention, then discarded.</p>

    <h2>Your rights</h2>
    <p>You can request access to, correction of, or deletion of your personal data by contacting us
    at ${CONTACT_LINK}.</p>

    <h2>Changes</h2>
    <p>We may update this policy; the "last updated" date above reflects the current version.</p>

    <h2>Contact</h2>
    <p>Questions about this policy? Email ${CONTACT_LINK}.</p>`;

  return renderLegalPage({
    title: "Privacy Policy",
    intro:
      "This policy explains what data canvas-drop collects, why, and how it is handled. We keep this to the minimum needed to run the service.",
    body,
    path: "/privacy",
    origin,
    skin,
  });
}

export function renderTermsPage(origin = "", skin: SkinName = "editorial"): string {
  const body = `
    <h2>Acceptance</h2>
    <p>By accessing or using canvas-drop, you agree to these Terms. If you do not agree, do not use
    the service.</p>

    <h2>The service</h2>
    <p>canvas-drop lets authenticated members deploy and share small static web artifacts
    ("canvases"). It is open-source software (MIT); this instance is operated by
    ${escapeHtml(OPERATOR.name)}.</p>

    <h2>Your account</h2>
    <p>You sign in through your organization's Google account. You are responsible for activity
    under your account and for keeping access to it secure.</p>

    <h2>Acceptable use</h2>
    <ul>
      <li>Do not deploy illegal, malicious, or infringing content, or malware.</li>
      <li>Do not attempt to break platform isolation or security, or abuse the service or other
      users.</li>
      <li>Do not use the service in violation of applicable law.</li>
    </ul>

    <h2>Your content</h2>
    <p>You retain ownership of the canvases you create. You grant us the limited rights needed to
    host, store, and serve them so the service can function. You are responsible for the content
    you deploy.</p>

    <h2>Availability and warranty</h2>
    <p>The service is provided "as is" and "as available", without warranties of any kind. We do
    not guarantee uninterrupted availability and may change, suspend, or discontinue features.</p>

    <h2>Termination</h2>
    <p>We may suspend or remove accounts or canvases that violate these Terms or put the platform at
    risk.</p>

    <h2>Limitation of liability</h2>
    <p>To the maximum extent permitted by law, we are not liable for any indirect or consequential
    damages arising from your use of the service.</p>

    <h2>Governing law</h2>
    <p>These Terms are governed by the laws of ${escapeHtml(OPERATOR.jurisdiction)}.</p>

    <h2>Changes</h2>
    <p>We may update these Terms; the "last updated" date above reflects the current version.</p>

    <h2>Contact</h2>
    <p>Questions about these Terms? Email ${CONTACT_LINK}.</p>`;

  return renderLegalPage({
    title: "Terms of Service",
    intro:
      "These Terms govern your use of this canvas-drop instance. They are intentionally short.",
    body,
    path: "/terms",
    origin,
    skin,
  });
}

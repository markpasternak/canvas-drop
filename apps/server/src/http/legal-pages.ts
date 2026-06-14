import type { Config } from "@canvas-drop/shared";
import { Hono } from "hono";
import { escapeAttribute, escapeHtml } from "./error-pages.js";
import { baseSecurityHeaders } from "./security-headers.js";
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
 * The pages are deliberately minimal, light-mode-only static HTML with light
 * canvas-drop branding — no SPA bundle, no client JS. Content is hardcoded for
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

export function legalRoutes(config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const origin = config.baseUrl;
  app.get("/privacy", () => htmlResponse(renderPrivacyPage(origin)));
  app.get("/terms", () => htmlResponse(renderTermsPage(origin)));
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

/** Open Graph + Twitter card tags. `origin` (config.baseUrl) makes the image/URL
 *  absolute — social crawlers require that; the card is served publicly at /og.png. */
function socialMeta(path: string, title: string, description: string, origin: string): string {
  const base = origin.replace(/\/$/, "");
  const t = escapeHtml(`${title} · canvas-drop`);
  const d = escapeHtml(
    description
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const image = escapeHtml(`${base}/og.png`);
  return `<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="canvas-drop">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${escapeHtml(`${base}${path}`)}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${image}">`;
}

/** Shared minimal, light-mode-only page chrome (logo + wordmark, title, body). */
function renderLegalPage(opts: {
  title: string;
  intro: string;
  body: string;
  path: string;
  origin: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} · canvas-drop</title>
${socialMeta(opts.path, opts.title, opts.intro, opts.origin)}
<style>
  :root {
    --canvas: #f5f5f2;
    --surface: #fbfbf8;
    --fg: #18181b;
    --muted: #5b5b63;
    --subtle: #898991;
    --border: #dfdfdc;
    --accent: #2563eb;
    --logo-frame: #111418;
    --logo-drop: #2563eb;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    min-height: 100dvh;
    padding: clamp(1.25rem, 4vw, 3rem);
    background: var(--canvas);
    color: var(--fg);
    font: 15px/1.6 "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  main {
    width: min(100%, 44rem);
    margin: 0 auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: .6rem;
    margin: 0 0 2rem;
    font-weight: 650;
    letter-spacing: -.011em;
    color: var(--fg);
    text-decoration: none;
  }
  .mark { width: 1.85rem; height: 1.85rem; flex: 0 0 auto; }
  h1 {
    margin: 0 0 .35rem;
    font-size: clamp(1.6rem, 5vw, 2.25rem);
    line-height: 1.1;
    letter-spacing: -.02em;
  }
  .updated {
    margin: 0 0 1.75rem;
    color: var(--subtle);
    font-size: .8125rem;
  }
  .intro { margin: 0 0 1.75rem; color: var(--muted); font-size: 1.0625rem; }
  h2 {
    margin: 2rem 0 .5rem;
    font-size: 1.0625rem;
    letter-spacing: -.01em;
  }
  p { margin: .6rem 0; color: var(--muted); }
  ul { margin: .6rem 0; padding-left: 1.25rem; color: var(--muted); }
  li { margin: .3rem 0; }
  strong { color: var(--fg); font-weight: 600; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer {
    margin-top: 2.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--border);
    color: var(--subtle);
    font-size: .8125rem;
  }
  .footer a { color: var(--muted); }
</style>
</head>
<body>
  <main>
    <a class="brand" href="/">
      <svg class="mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <path d="M14 37h-4a5 5 0 0 1-5-5V11a5 5 0 0 1 5-5h28a5 5 0 0 1 5 5v21a5 5 0 0 1-5 5h-4" stroke="var(--logo-frame)" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.75"/>
        <path d="M24 14v16.5m-7-7 7 7 7-7" stroke="var(--logo-drop)" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.75"/>
        <path d="M18 40h12" stroke="var(--logo-drop)" stroke-linecap="round" stroke-width="4.75"/>
      </svg>
      <span>canvas-drop</span>
    </a>
    <h1>${escapeHtml(opts.title)}</h1>
    <p class="updated">Last updated ${escapeHtml(OPERATOR.lastUpdated)}</p>
    <p class="intro">${opts.intro}</p>
    ${opts.body}
    <div class="footer">
      <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a><br>
      ${escapeHtml(OPERATOR.name)}
    </div>
  </main>
</body>
</html>`;
}

const CONTACT_LINK = `<a href="mailto:${escapeAttribute(OPERATOR.contactEmail)}">${escapeHtml(OPERATOR.contactEmail)}</a>`;

export function renderPrivacyPage(origin = ""): string {
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
  });
}

export function renderTermsPage(origin = ""): string {
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
  });
}

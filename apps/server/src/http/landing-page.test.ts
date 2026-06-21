import { type Config, loadConfig, MARKETING_ACCENT } from "@canvas-drop/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../auth/session.js";
import { landingGate, landingResponse, renderLandingPage } from "./landing-page.js";
import type { AppEnv } from "./types.js";

const oidc: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvas-drop.com",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_OIDC_ISSUER: "https://accounts.google.com",
  CANVAS_DROP_OIDC_CLIENT_ID: "cid",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
});
const dev: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const proxy: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "proxy",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvas-drop.com",
  CANVAS_DROP_SESSION_SECRET: "x".repeat(40),
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_TRUSTED_PROXY_IPS: "10.0.0.1",
});

describe("landing page design skin", () => {
  it("omits data-skin for the default editorial skin (matches the SPA's attribute-free default)", () => {
    const html = renderLandingPage("https://x.com", "oidc", false);
    // The <html> tag carries no skin attribute (editorial is the base :root); the CSS still
    // ships the alternate [data-skin] override blocks, so assert against the tag specifically.
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('data-skin="editorial"');
  });

  it("stamps the chosen skin on <html> and ships the skin override CSS", () => {
    const html = renderLandingPage("https://x.com", "oidc", false, "canvas");
    expect(html).toContain('data-skin="canvas"');
    // The override block for the chosen skin is present (selected by the attribute).
    expect(html).toContain(':root[data-skin="canvas"]');
    expect(html).toContain(':root[data-skin="workshop"]');
  });

  it("re-voices the hero with the skin: h1 uses --font-display and alternates remap the marketing accent", () => {
    const html = renderLandingPage("https://x.com", "oidc", false, "workshop");
    // The hero title follows the skin's display face (editorial keeps the serif
    // because --font-display defaults to it; workshop/canvas re-voice it).
    expect(html).toContain("font-family: var(--font-display)");
    // Any non-default skin remaps the marketing accent (--amber) to the skin
    // accent, so the hero accent + CTA follow the active skin rather than staying
    // a fixed amber. Editorial stamps no data-skin, so this rule never fires for it.
    expect(html).toContain(
      ":root[data-skin] { --amber: var(--accent); --amber-ink: var(--accent); }",
    );
  });

  it("keeps the editorial hero on its fixed amber (the remap is scoped to [data-skin])", () => {
    const html = renderLandingPage("https://x.com", "oidc", false, "editorial");
    expect(html).not.toContain('data-skin="editorial"');
    // The hero accent clause still resolves to the marketing amber, not the skin
    // accent — the [data-skin] remap can't match an attribute-free <html>.
    expect(html).toContain("h1 .accent { font-style: italic; color: var(--amber); }");
  });

  it("landingResponse stamps the instance's configured skin", async () => {
    const cfg = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev", CANVAS_DROP_DESIGN_SKIN: "studio" });
    const html = await landingResponse(cfg, { signedIn: false }).text();
    expect(html).toContain('data-skin="studio"');
  });
});

/** Mount landingGate ahead of a sentinel that stands in for the gateway + SPA. */
function app(config: Config) {
  const a = new Hono<AppEnv>();
  a.use("*", landingGate({ config }));
  a.all("*", (c) => c.text("FELL_THROUGH", 418));
  return a;
}

const HTML = { accept: "text/html,application/xhtml+xml" };
/** Headers for a request that carries a session cookie (a signed-in human). */
const SIGNED_IN = { ...HTML, cookie: `${SESSION_COOKIE}=tok` };

describe("landing page — rendered content", () => {
  it("carries full Open Graph + Twitter + canonical + indexable SEO tags", () => {
    const html = renderLandingPage("https://canvas-drop.com");
    expect(html).toContain('property="og:image" content="https://canvas-drop.com/og.png"');
    expect(html).toContain('property="og:url" content="https://canvas-drop.com/"');
    expect(html).toContain('property="og:type" content="website"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('<link rel="canonical" href="https://canvas-drop.com/">');
    // The marketing page — unlike the gated surfaces — is meant to be indexed.
    expect(html).toContain('name="robots" content="index,follow"');
    expect(html).toContain("application/ld+json");
    // Favicon links so the signed-out page shows an icon (served pre-gateway).
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain('rel="manifest" href="/site.webmanifest"');
  });

  it("targets the auth-mode-appropriate sign-in destination", () => {
    // oidc owns a login page; dev/proxy don't, so the CTA opens the app at `/`.
    expect(renderLandingPage("https://x", "oidc")).toContain('href="/auth/login"');
    const devHtml = renderLandingPage("https://x", "dev");
    expect(devHtml).not.toContain("/auth/login");
    expect(devHtml).toContain("Open canvas-drop");
  });

  it("drives sign-in and links docs, terms, privacy, and the OSS repo", () => {
    const html = renderLandingPage();
    expect(html).toContain('href="/auth/login"');
    expect(html).toContain('href="/docs"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("github.com/markpasternak/canvas-drop");
  });

  it("shows the five primitives and references the regenerable screenshots", () => {
    const html = renderLandingPage();
    for (const tag of ["kv", "files", "ai", "identity", "realtime"]) {
      expect(html).toContain(`>${tag}</span>`);
    }
    // Dark, populated marketing shots served at /docs/assets (pnpm landing:screenshots).
    // Each carries a `?v=<hash>` cache-bust, so match the path without the closing quote.
    expect(html).toContain('src="/docs/assets/landing-dashboard.webp');
    expect(html).toContain('src="/docs/assets/landing-gallery.webp');
  });

  it("renders the editorial serif hero with the amber second accent (Committed bold)", () => {
    const html = renderLandingPage();
    // The hero headline carries the self-hosted serif and the italic-accent clause.
    expect(html).toContain("--font-serif:");
    expect(html).toContain('<span class="accent">Share it out.</span>');
    // h1.accent is the italic amber clause.
    expect(html).toMatch(/h1 \.accent \{[^}]*font-style: italic[^}]*color: var\(--amber\)/);
    // The amber comes from MARKETING_ACCENT (shared) — sourced, never inlined.
    expect(html).toContain(`--amber: ${MARKETING_ACCENT.light.amber};`);
    expect(html).toContain(`--amber-ink: ${MARKETING_ACCENT.light["amber-ink"]};`);
    // Decorative chrome references the token, not a hard-coded amber value.
    expect(html).toContain("var(--amber)");
    // Per-primitive colour tints are present.
    expect(html).toContain('class="prim p-kv"');
    expect(html).toContain('class="prim p-realtime"');
    // No indigo-violet anywhere (the parity scan's hue — kept clean).
    expect(html).not.toMatch(/oklch\([^)]*\b27[0-9]\b/);
  });

  it("self-hosts the Newsreader serif — no external/CDN font request (no phone-home)", () => {
    const html = renderLandingPage();
    // @font-face points at the same-origin, self-served woff2 (brandAssetRoutes).
    expect(html).toContain("@font-face");
    expect(html).toContain("/fonts/newsreader-latin-wght-normal.woff2");
    expect(html).toContain("/fonts/newsreader-latin-standard-italic.woff2");
    expect(html).toContain('font-family: "Newsreader Variable"');
    // --font-serif resolves to the self-hosted family for the editorial hero.
    expect(html).toContain("--font-serif:");
    // Absolutely no external font sources.
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
  });

  it("includes the product-tour carousel and the team + privacy sections", () => {
    const html = renderLandingPage();
    // Embla carousel: the viewport + the bundled controller script.
    expect(html).toContain("data-embla");
    expect(html).toContain('src="/docs/assets/landing-carousel.js"');
    expect(html).toContain('src="/docs/assets/tour-editor.webp');
    expect(html).toContain("Built for teams");
    expect(html).toContain("Private by design");
    expect(html).toContain("No telemetry, ever");
  });

  it("shows the sharing-ladder section with every rung and the auth-delegated-invite story (plan 003)", () => {
    const html = renderLandingPage();
    // The ladder heading + each rung in product order.
    expect(html).toContain("An access ladder that fits how people actually share.");
    for (const rung of ["Private", "Specific people", "Team", "Whole org", "Public link"]) {
      expect(html).toContain(`class="r-name">${rung}`);
    }
    // The Team rung is the accented (feature) one.
    expect(html).toContain('class="rung feature"');
    // The headline differentiator: auth-delegated invites (no app-owned credentials).
    expect(html).toContain("no app-managed passwords, no magic-link accounts");
    // The Teams capability also appears in the "Built for teams" grid + the tour.
    expect(html).toContain("Teams &amp; invites");
    expect(html).toContain('src="/docs/assets/tour-teams.webp');
  });
});

describe("landingResponse — headers", () => {
  it("returns frame-locked, non-shared-cacheable HTML with a CSP", () => {
    const res = landingResponse(oidc);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // CTA varies by session → must not be shared-cached across auth states.
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("swaps the CTA to 'Open dashboard' → / for a signed-in viewer", () => {
    const signedIn = renderLandingPage("https://x", "oidc", true);
    expect(signedIn).toContain("Open dashboard");
    expect(signedIn).not.toContain("/auth/login");
    const signedOut = renderLandingPage("https://x", "oidc", false);
    expect(signedOut).toContain('href="/auth/login"');
    expect(signedOut).not.toContain("Open dashboard");
  });
});

describe("landingGate — front-door routing", () => {
  it("renders the landing for a signed-out GET / in oidc mode", async () => {
    const res = await app(oidc).request("/", { headers: HTML });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Share it out.");
  });

  it("renders the landing for the BASE host root (apex front door)", async () => {
    const res = await app(oidc).request("/", { headers: { ...HTML, host: "canvas-drop.com" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Share it out.");
  });

  it("falls through on a canvas SUBDOMAIN root so the gateway can redirect to login with a returnTo", async () => {
    // A gated canvas root visited signed-out must NOT show the generic welcome page —
    // it should reach the login redirect (which now carries a returnTo to the canvas).
    const res = await app(oidc).request("/", {
      headers: { ...HTML, host: "dusky-thistle-abc.canvas-drop.com" },
    });
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("FELL_THROUGH");
  });

  it("falls through to the dashboard when a session cookie is present", async () => {
    const res = await app(oidc).request("/", { headers: SIGNED_IN });
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("FELL_THROUGH");
  });

  it("falls through when a guest/public principal is already set", async () => {
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("principal", { kind: "guest", canvasId: "c1" } as never);
      await next();
    });
    a.use("*", landingGate({ config: oidc }));
    a.all("*", (c) => c.text("FELL_THROUGH", 418));
    const res = await a.request("/", { headers: HTML });
    expect(res.status).toBe(418);
  });

  it("never intercepts non-root paths", async () => {
    const res = await app(oidc).request("/gallery", { headers: HTML });
    expect(res.status).toBe(418);
  });

  it("never intercepts non-GET methods", async () => {
    const res = await app(oidc).request("/", { method: "POST", headers: HTML });
    expect(res.status).toBe(418);
  });

  it("is inert in proxy mode (IAP fronts the app)", async () => {
    const res = await app(proxy).request("/", { headers: HTML });
    expect(res.status).toBe(418);
  });

  it("is inert in dev mode (always signed in → dashboard)", async () => {
    const res = await app(dev).request("/", { headers: HTML });
    expect(res.status).toBe(418);
  });
});

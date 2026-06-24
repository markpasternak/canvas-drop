import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../auth/session.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import { socialPreview } from "./social-preview.js";
import type { AppEnv, Principal } from "./types.js";

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

/** Mount the middleware ahead of a sentinel that marks "the gateway would run". */
function app(config: Config) {
  const a = new Hono<AppEnv>();
  a.use("*", socialPreview(config));
  a.all("*", (c) => c.text("PASSED_THROUGH", 418));
  return a;
}

const HTML = { accept: "text/html,application/xhtml+xml" };

describe("socialPreview", () => {
  it("serves a generic OG card to a signed-out HTML navigation in oidc mode", async () => {
    const res = await app(oidc).request("/", {
      headers: { host: "showcase.canvas-drop.com", ...HTML },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // Absolute og:image on THIS host (subdomain), not the apex.
    expect(body).toContain('property="og:image" content="https://showcase.canvas-drop.com/og.png"');
    expect(body).toContain('name="twitter:card" content="summary_large_image"');
    // Humans are redirected on to login (parity with the gateway), carrying a
    // returnTo so they land back on this shared canvas, not the apex welcome page.
    const returnTo = encodeURIComponent("https://showcase.canvas-drop.com/");
    expect(body).toContain(`url=/auth/login?returnTo=${returnTo}`);
    expect(body).toContain(`location.replace("/auth/login?returnTo=${returnTo}")`);
    // Never indexed.
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("catches a crawler that sends Accept: */* but a recognizable UA", async () => {
    const res = await app(oidc).request("/c/app/", {
      headers: { host: "canvas-drop.com", accept: "*/*", "user-agent": "facebookexternalhit/1.1" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("og:image");
  });

  it("passes through when a session cookie is present (let the gateway decide)", async () => {
    const res = await app(oidc).request("/", {
      headers: { host: "showcase.canvas-drop.com", ...HTML, cookie: `${SESSION_COOKIE}=tok` },
    });
    expect(res.status).toBe(418);
  });

  it("passes through non-document requests (API/asset fetches)", async () => {
    const res = await app(oidc).request("/api/me", {
      headers: { host: "canvas-drop.com", accept: "application/json" },
    });
    expect(res.status).toBe(418);
  });

  it("passes through non-GET requests", async () => {
    const res = await app(oidc).request("/", {
      method: "POST",
      headers: { host: "x.canvas-drop.com", ...HTML },
    });
    expect(res.status).toBe(418);
  });

  it("is a no-op outside oidc mode (dev/proxy don't bounce to an external login)", async () => {
    const res = await app(dev).request("/", { headers: { host: "localhost", ...HTML } });
    expect(res.status).toBe(418);
  });
});

/** Stub repo returning a canvas with the given title (or null = not found).
 *  Defaults to an UNGATED public_link so the per-canvas card renders; pass overrides
 *  (e.g. a passwordHash or sharedExpiresAt) to exercise the gated path, which the card
 *  guard (isAnonymouslyPublic) must suppress. */
function canvasRepo(
  title: string | null,
  overrides: Record<string, unknown> = {},
): CanvasesRepository {
  return {
    findBySlug: async () =>
      title === null
        ? null
        : { title, access: "public_link", passwordHash: null, sharedExpiresAt: null, ...overrides },
  } as unknown as CanvasesRepository;
}

/** Mount socialPreview behind a middleware that pre-sets a non-org principal. */
function appAs(config: Config, principal: Principal, repo: CanvasesRepository) {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  a.use("*", socialPreview(config, repo));
  a.all("*", (c) => c.text("PASSED_THROUGH", 418));
  return a;
}

const ANON: Principal = { kind: "anonymous" };

describe("socialPreview — public_link per-canvas card", () => {
  it("serves a per-canvas OG card (with the canvas title) to a crawler", async () => {
    const res = await appAs(oidc, ANON, canvasRepo("Quarterly Planner")).request("/", {
      headers: { host: "planner.canvas-drop.com", accept: "*/*", "user-agent": "Slackbot 1.0" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('property="og:title" content="Quarterly Planner"');
    expect(body).toContain('property="og:image" content="https://planner.canvas-drop.com/og.png"');
    // Crawler-only card → no human redirect injected.
    expect(body).not.toContain("location.replace");
  });

  it("falls through to the real canvas for a human visitor (no crawler UA)", async () => {
    const res = await appAs(oidc, ANON, canvasRepo("Quarterly Planner")).request("/", {
      headers: {
        host: "planner.canvas-drop.com",
        ...HTML,
        "user-agent": "Mozilla/5.0 (Macintosh)",
      },
    });
    expect(res.status).toBe(418);
  });

  it("escapes a hostile canvas title in the card (user-controlled content)", async () => {
    const res = await appAs(oidc, ANON, canvasRepo("<img src=x onerror=alert(1)>")).request("/", {
      headers: { host: "x.canvas-drop.com", accept: "*/*", "user-agent": "Twitterbot/1.0" },
    });
    const body = await res.text();
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img");
  });

  it("does NOT serve a per-canvas card for a PASSWORD-PROTECTED public_link (gated → no title/og leak, R5)", async () => {
    const res = await appAs(
      oidc,
      ANON,
      canvasRepo("Secret Planner", { passwordHash: "hash" }),
    ).request("/", {
      headers: { host: "planner.canvas-drop.com", accept: "*/*", "user-agent": "Slackbot 1.0" },
    });
    // Reachable-anonymous (it reaches its password gate downstream), but the crawler
    // card is suppressed — it falls through rather than emitting the title/image.
    expect(res.status).toBe(418);
  });

  it("does NOT serve a per-canvas card for an EXPIRED public_link share", async () => {
    const res = await appAs(
      oidc,
      ANON,
      canvasRepo("Expired Planner", { sharedExpiresAt: 1 }),
    ).request("/", {
      headers: { host: "planner.canvas-drop.com", accept: "*/*", "user-agent": "Slackbot 1.0" },
    });
    expect(res.status).toBe(418);
  });

  it("does NOT serve a per-canvas card for a guest principal (semi-private)", async () => {
    const guest: Principal = {
      kind: "guest",
      id: "guest:1",
      inviteId: "1",
      canvasId: "c1",
      email: "g@example.com",
    };
    const res = await appAs(oidc, guest, canvasRepo("Secret Canvas")).request("/", {
      headers: {
        host: "secret.canvas-drop.com",
        accept: "*/*",
        "user-agent": "facebookexternalhit/1.1",
      },
    });
    expect(res.status).toBe(418);
  });
});

describe("socialPreview — per-canvas preview OG image (plan 004 / U9)", () => {
  const crawler = { host: "planner.canvas-drop.com", accept: "*/*", "user-agent": "Slackbot 1.0" };

  function appWithPreview(previewUrl: string | null) {
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("principal", ANON);
      await next();
    });
    a.use(
      "*",
      socialPreview(oidc, canvasRepo("Planner"), async () => previewUrl),
    );
    a.all("*", (c) => c.text("PASSED_THROUGH", 418));
    return a;
  }

  it("uses the per-canvas preview as og:image when the resolver provides one", async () => {
    const url = "https://planner.canvas-drop.com/c/p/__canvasdrop_preview?rendition=og&v=1";
    const body = await (await appWithPreview(url).request("/", { headers: crawler })).text();
    // og:image is the per-canvas preview (& escaped to &amp; in the attribute).
    expect(body).toContain(
      'property="og:image" content="https://planner.canvas-drop.com/c/p/__canvasdrop_preview?rendition=og&amp;v=1"',
    );
    expect(body).not.toContain("/og.png");
  });

  it("falls back to /og.png when the resolver returns null (disabled or not yet captured)", async () => {
    const body = await (await appWithPreview(null).request("/", { headers: crawler })).text();
    expect(body).toContain('property="og:image" content="https://planner.canvas-drop.com/og.png"');
  });

  it("falls back to /og.png (never 500s) when the preview resolver throws (review #6)", async () => {
    const a = new Hono<AppEnv>();
    a.use("*", async (c, next) => {
      c.set("principal", ANON);
      await next();
    });
    a.use(
      "*",
      socialPreview(oidc, canvasRepo("Planner"), async () => {
        throw new Error("settings/job lookup DB blip");
      }),
    );
    a.all("*", (c) => c.text("PASSED_THROUGH", 418));
    const res = await a.request("/", { headers: crawler });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      'property="og:image" content="https://planner.canvas-drop.com/og.png"',
    );
  });
});

import type { Canvas } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { AppEnv } from "../http/types.js";
import { type AccessUser, canvasAccess, decideCanvasAccess } from "./authorization.js";

const NOW = 1_000_000;

/** Build a canvas row with sensible defaults; override per test. */
function canvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    id: "cv1",
    slug: "s",
    title: "",
    description: null,
    ownerId: "owner",
    shared: false,
    sharedAt: null,
    sharedExpiresAt: null,
    galleryListed: false,
    gallerySummary: null,
    galleryTags: null,
    galleryPublishedAt: null,
    passwordHash: null,
    passwordVersion: 0,
    spaFallback: false,
    backendEnabled: false,
    capKv: true,
    capFiles: true,
    capAi: true,
    capRealtime: true,
    apiKeyHash: "h",
    status: "active",
    disabledReason: null,
    currentVersionId: "v1",
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  };
}

const owner: AccessUser = { id: "owner", isAdmin: false };
const other: AccessUser = { id: "other", isAdmin: false };
const admin: AccessUser = { id: "admin", isAdmin: true };

// --- REJECTION PATHS FIRST (auth-invariant-checklist: test the gate, not the happy path) ---

describe("decideCanvasAccess — denials", () => {
  it("owner-only canvas: 404 to a different user (don't confirm existence)", () => {
    const d = decideCanvasAccess(canvas({ shared: false }), other, NOW);
    expect(d).toEqual({ action: "deny", status: 404, reason: "owner_only" });
  });

  it("revoked share: a once-shared canvas set shared=false is 404 (owner_only) to non-owners now", () => {
    expect(decideCanvasAccess(canvas({ shared: false, sharedAt: NOW - 1 }), other, NOW)).toEqual({
      action: "deny",
      status: 404,
      reason: "owner_only",
    });
  });

  it("disabled is checked before the owner/admin bypass — owner AND admin get 403", () => {
    // the check ORDER is the invariant: disabled (step 2) fires before owner/admin (step 3)
    const disabled = canvas({ status: "disabled" });
    expect(decideCanvasAccess(disabled, owner, NOW)).toMatchObject({ status: 403 });
    expect(decideCanvasAccess(disabled, admin, NOW)).toMatchObject({ status: 403 });
  });

  it("expired share: 404 to non-owner once past sharedExpiresAt", () => {
    const d = decideCanvasAccess(canvas({ shared: true, sharedExpiresAt: NOW - 1 }), other, NOW);
    expect(d).toEqual({ action: "deny", status: 404, reason: "share_expired" });
  });

  it("disabled: 403 to non-owner", () => {
    const d = decideCanvasAccess(canvas({ status: "disabled", shared: true }), other, NOW);
    expect(d).toEqual({ action: "deny", status: 403, reason: "disabled" });
  });

  it("deleted: 404 to everyone, including the owner", () => {
    expect(decideCanvasAccess(canvas({ status: "deleted" }), owner, NOW).action).toBe("deny");
    expect(decideCanvasAccess(canvas({ status: "deleted" }), owner, NOW)).toMatchObject({
      status: 404,
    });
  });

  it("archived: 404 to everyone, checked before owner/admin (offline, restorable)", () => {
    // the check ORDER is the invariant: archived fires before owner/admin, so even
    // the owner sees their own archived canvas as gone on the public path.
    const archived = canvas({ status: "archived" });
    expect(decideCanvasAccess(archived, owner, NOW)).toEqual({
      action: "deny",
      status: 404,
      reason: "archived",
    });
    expect(decideCanvasAccess(archived, other, NOW)).toMatchObject({ status: 404 });
    expect(decideCanvasAccess(archived, admin, NOW)).toMatchObject({ status: 404 });
  });

  it("archived overrides share: a shared, live, archived canvas is still 404", () => {
    // archive precedes the share/password branches — it is never evaluated against them.
    const d = decideCanvasAccess(
      canvas({ status: "archived", shared: true, sharedExpiresAt: NOW + 1000, passwordHash: "h" }),
      other,
      NOW,
    );
    expect(d).toEqual({ action: "deny", status: 404, reason: "archived" });
  });

  it("unknown slug (null canvas): 404", () => {
    expect(decideCanvasAccess(null, owner, NOW)).toEqual({
      action: "deny",
      status: 404,
      reason: "not_found",
    });
  });
});

// --- ALLOW PATHS ---

describe("decideCanvasAccess — allows", () => {
  it("owner always reaches their own canvas regardless of share state, bypassing the gate", () => {
    const d = decideCanvasAccess(canvas({ shared: false, passwordHash: "h" }), owner, NOW);
    expect(d).toEqual({ action: "allow", needsPasswordGate: false });
  });

  it("admin reaches an owner-only canvas (takedown/restore), bypassing the gate", () => {
    expect(decideCanvasAccess(canvas({ shared: false }), admin, NOW)).toEqual({
      action: "allow",
      needsPasswordGate: false,
    });
  });

  it("shared + live: allowed for any member; needsPasswordGate reflects the password", () => {
    expect(decideCanvasAccess(canvas({ shared: true }), other, NOW)).toEqual({
      action: "allow",
      needsPasswordGate: false,
    });
    expect(decideCanvasAccess(canvas({ shared: true, passwordHash: "h" }), other, NOW)).toEqual({
      action: "allow",
      needsPasswordGate: true,
    });
  });

  it("shared with a future expiry: allowed before the deadline", () => {
    expect(
      decideCanvasAccess(canvas({ shared: true, sharedExpiresAt: NOW + 1000 }), other, NOW).action,
    ).toBe("allow");
  });
});

// --- canvasAccess middleware: the disabled-page rendering (U5, §6.10.2) ---

describe("canvasAccess — disabled-canvas rendering", () => {
  /** Minimal app: inject slug + user, run canvasAccess over a fake repo. */
  function appFor(cv: Canvas | null, user: AccessUser) {
    const canvases = {
      async findBySlug() {
        return cv;
      },
    } as unknown as CanvasesRepository;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("canvasSlug", "s");
      c.set("user", { id: user.id, isAdmin: user.isAdmin } as never);
      await next();
    });
    app.use("*", canvasAccess({ canvases }));
    app.get("*", (c) => c.text("CANVAS CONTENT")); // only reached on allow
    return app;
  }

  it("browser gets a 403 HTML 'disabled' page (no reason interpolated)", async () => {
    const app = appFor(canvas({ status: "disabled", disabledReason: "secret op note" }), other);
    const res = await app.request("/", { headers: { accept: "text/html" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("disabled");
    expect(html).not.toContain("secret op note"); // reason never on the public page
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("programmatic client gets 403 JSON { error: disabled }", async () => {
    const app = appFor(canvas({ status: "disabled" }), other);
    const res = await app.request("/", { headers: { accept: "application/json" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "disabled" });
  });

  it("an ADMIN is not exempted — the disabled page is served, never the content (§12.0 #5)", async () => {
    const app = appFor(canvas({ status: "disabled" }), admin);
    const res = await app.request("/", { headers: { accept: "text/html" } });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("CANVAS CONTENT");
  });

  it("an active canvas still serves content (no regression)", async () => {
    const app = appFor(canvas({ status: "active", ownerId: "owner" }), owner);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CANVAS CONTENT");
  });

  // §12.2 / D23: every 404 denial reason must collapse to an OPAQUE body at the
  // HTTP layer. A non-owner must not tell an archived / owner-only / expired-share
  // canvas apart from one that never existed — the decision keeps distinct reasons
  // internally (for 403 routing / audit), but the wire never sees them on a 404.
  it("404 denials are opaque — archived/owner-only/expired all return { error: not_found }", async () => {
    const denied: Canvas[] = [
      canvas({ status: "archived" }), // archived → 404
      canvas({ status: "active", shared: false }), // owner-only → 404 to `other`
      canvas({ status: "active", shared: true, sharedExpiresAt: NOW - 1 }), // expired → 404
    ];
    for (const cv of denied) {
      const res = await appFor(cv, other).request("/", { headers: { accept: "application/json" } });
      expect(res.status).toBe(404);
      // The internal reason (archived/owner_only/share_expired) never reaches the
      // client — not in the JSON, and (since the branded error page derives its
      // copy from this body's `error`) not on the browser HTML page either.
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});

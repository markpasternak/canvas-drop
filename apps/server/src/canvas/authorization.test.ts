import type { Canvas } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { AppEnv, Principal } from "../http/types.js";
import { canvasAccess, decideCanvasAccess, principalLookupKey } from "./authorization.js";

const NOW = 1_000_000;

/** Build a canvas row with sensible defaults; override per test. */
function canvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    id: "cv1",
    slug: "s",
    title: "",
    description: null,
    ownerId: "owner",
    access: "private",
    sharedExpiresAt: null,
    galleryListed: false,
    galleryTemplatable: false,
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
    guestAiEnabled: false,
    guestAiCap: 0,
    apiKeyHash: "h",
    status: "active",
    disabledReason: null,
    currentVersionId: "v1",
    clonedFromCanvasId: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  };
}

const owner: Principal = { kind: "member", id: "owner", isAdmin: false };
const other: Principal = { kind: "member", id: "other", isAdmin: false };
const admin: Principal = { kind: "member", id: "admin", isAdmin: true };
const anon: Principal = { kind: "anonymous" };
const guest = (canvasId = "cv1", email = "g@x.com"): Principal => ({
  kind: "guest",
  id: `guest:inv1`,
  inviteId: "inv1",
  canvasId,
  email,
});

// --- REJECTION PATHS FIRST (auth-invariant-checklist: test the gate, not the happy path) ---

describe("decideCanvasAccess — denials", () => {
  it("private canvas: 404 to a different member (don't confirm existence)", () => {
    expect(decideCanvasAccess(canvas({ access: "private" }), other, NOW)).toEqual({
      action: "deny",
      status: 404,
      reason: "owner_only",
    });
  });

  it("disabled is checked before the owner/admin bypass — owner AND admin get 403", () => {
    const disabled = canvas({ status: "disabled" });
    expect(decideCanvasAccess(disabled, owner, NOW)).toMatchObject({ status: 403 });
    expect(decideCanvasAccess(disabled, admin, NOW)).toMatchObject({ status: 403 });
  });

  it("expired share: 404 to non-owner once past sharedExpiresAt", () => {
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", sharedExpiresAt: NOW - 1 }), other, NOW),
    ).toEqual({ action: "deny", status: 404, reason: "share_expired" });
  });

  it("deleted / archived: 404 to everyone, checked before owner/admin", () => {
    expect(decideCanvasAccess(canvas({ status: "deleted" }), owner, NOW)).toMatchObject({
      status: 404,
      reason: "not_found",
    });
    const archived = canvas({ status: "archived", access: "whole_org", passwordHash: "h" });
    for (const p of [owner, other, admin]) {
      expect(decideCanvasAccess(archived, p, NOW)).toMatchObject({
        status: 404,
        reason: "archived",
      });
    }
  });

  it("unknown slug (null canvas): 404", () => {
    expect(decideCanvasAccess(null, owner, NOW)).toEqual({
      action: "deny",
      status: 404,
      reason: "not_found",
    });
  });

  // AE1: a guest invited to one canvas can never reach another, at any rung.
  it("guest scoped to canvas X is 404 on canvas Y (AE1)", () => {
    const cv = canvas({ id: "cvY", access: "whole_org" });
    expect(decideCanvasAccess(cv, guest("cvX"), NOW)).toEqual({
      action: "deny",
      status: 404,
      reason: "not_invited",
    });
  });

  it("whole_org excludes non-members (guest / anonymous → 404)", () => {
    const cv = canvas({ access: "whole_org" });
    expect(decideCanvasAccess(cv, guest("cv1"), NOW)).toMatchObject({ status: 404 });
    expect(decideCanvasAccess(cv, anon, NOW)).toMatchObject({ status: 404 });
  });

  it("specific_people: a member NOT on the allowlist is 404", () => {
    expect(
      decideCanvasAccess(canvas({ access: "specific_people" }), other, NOW, { isAllowed: false }),
    ).toMatchObject({ status: 404, reason: "owner_only" });
  });

  it("specific_people: anonymous is always 404", () => {
    expect(
      decideCanvasAccess(canvas({ access: "specific_people" }), anon, NOW, { isAllowed: true }),
    ).toMatchObject({ status: 404 });
  });

  it("public_link: 404 when the owner account may not publish (U10 gate)", () => {
    expect(
      decideCanvasAccess(canvas({ access: "public_link" }), anon, NOW, { publicEnabled: false }),
    ).toMatchObject({ status: 404 });
  });
});

// --- ALLOW PATHS ---

describe("decideCanvasAccess — allows", () => {
  it("owner reaches any rung, full, bypassing the gate", () => {
    const cv = canvas({ access: "private", passwordHash: "h" });
    expect(decideCanvasAccess(cv, owner, NOW)).toEqual({
      action: "allow",
      needsPasswordGate: false,
      staticOnly: false,
    });
  });

  // Admin CONTENT restriction: an admin is treated like a normal member for content
  // (private / unlisted specific_people → 404), but keeps the password bypass on the
  // rungs they CAN reach. Admin management (block/archive/delete) is on other routes.
  it("admin does NOT bypass the rung for content — private is 404 to a non-owner admin", () => {
    expect(decideCanvasAccess(canvas({ access: "private" }), admin, NOW)).toEqual({
      action: "deny",
      status: 404,
      reason: "owner_only",
    });
  });

  it("admin is 404 on a specific_people canvas they're not allowlisted on", () => {
    expect(
      decideCanvasAccess(canvas({ access: "specific_people" }), admin, NOW, { isAllowed: false }),
    ).toMatchObject({ status: 404, reason: "owner_only" });
  });

  it("admin reaches whole_org (as a member) and FACES its password gate, like any member", () => {
    // Admins get no password bypass on canvases they don't own — treated as a member.
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", passwordHash: "h" }), admin, NOW),
    ).toEqual({ action: "allow", needsPasswordGate: true, staticOnly: false });
    // …and no gate when the canvas has no password.
    expect(decideCanvasAccess(canvas({ access: "whole_org" }), admin, NOW)).toMatchObject({
      action: "allow",
      needsPasswordGate: false,
    });
  });

  it("admin sees a public_link canvas static-only, like any non-owner member", () => {
    expect(
      decideCanvasAccess(canvas({ access: "public_link" }), admin, NOW, { publicEnabled: true }),
    ).toMatchObject({ action: "allow", staticOnly: true });
  });

  it("admin is 404 on an expired whole_org share, like a normal member", () => {
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", sharedExpiresAt: NOW - 1 }), admin, NOW),
    ).toMatchObject({ action: "deny", reason: "share_expired" });
  });

  it("an allowlisted admin reaches a specific_people canvas (explicitly granted)", () => {
    expect(
      decideCanvasAccess(canvas({ access: "specific_people" }), admin, NOW, { isAllowed: true }),
    ).toMatchObject({ action: "allow", staticOnly: false });
  });

  it("whole_org: any member; needsPasswordGate reflects the password", () => {
    expect(decideCanvasAccess(canvas({ access: "whole_org" }), other, NOW)).toEqual({
      action: "allow",
      needsPasswordGate: false,
      staticOnly: false,
    });
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", passwordHash: "h" }), other, NOW),
    ).toMatchObject({ action: "allow", needsPasswordGate: true });
  });

  it("specific_people: an allowlisted member or guest is allowed (full)", () => {
    expect(
      decideCanvasAccess(canvas({ access: "specific_people" }), other, NOW, { isAllowed: true }),
    ).toEqual({ action: "allow", needsPasswordGate: false, staticOnly: false });
    expect(
      decideCanvasAccess(canvas({ access: "specific_people" }), guest("cv1"), NOW, {
        isAllowed: true,
      }),
    ).toMatchObject({ action: "allow", staticOnly: false });
  });

  it("specific_people: a guest bypasses the password gate (the magic link is the gate)", () => {
    expect(
      decideCanvasAccess(
        canvas({ access: "specific_people", passwordHash: "h" }),
        guest("cv1"),
        NOW,
        {
          isAllowed: true,
        },
      ),
    ).toMatchObject({ action: "allow", needsPasswordGate: false });
  });

  it("public_link: anonymous AND non-owner members are allowed static-only (R17)", () => {
    // The owner's publish capability is resolved into ctx.publicEnabled (U10).
    expect(
      decideCanvasAccess(canvas({ access: "public_link" }), anon, NOW, { publicEnabled: true }),
    ).toEqual({
      action: "allow",
      needsPasswordGate: false,
      staticOnly: true,
    });
    expect(
      decideCanvasAccess(canvas({ access: "public_link" }), other, NOW, { publicEnabled: true }),
    ).toMatchObject({
      action: "allow",
      staticOnly: true,
    });
  });

  it("public_link: default-deny when publicEnabled is unresolved in the ctx (U10)", () => {
    // The decision table is self-sufficient: an absent publicEnabled denies rather
    // than failing open, independent of the admin revoke sweep (§12.0 #3 defense-in-depth).
    expect(decideCanvasAccess(canvas({ access: "public_link" }), anon, NOW)).toMatchObject({
      action: "deny",
      status: 404,
    });
  });

  it("public_link: an owner still gets full (not static-only)", () => {
    expect(decideCanvasAccess(canvas({ access: "public_link" }), owner, NOW)).toMatchObject({
      action: "allow",
      staticOnly: false,
    });
  });
});

// --- canvasAccess middleware: the disabled-page rendering (U5, §6.10.2) ---

describe("canvasAccess — disabled-canvas rendering", () => {
  /** Minimal app: inject slug + user, run canvasAccess over a fake repo. */
  function appFor(cv: Canvas | null, user: { id: string; isAdmin: boolean }) {
    const canvases = {
      async findBySlug() {
        return cv;
      },
      async isPrincipalAllowed() {
        return false;
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
  // canvas apart from one that never existed.
  it("404 denials are opaque — archived/owner-only/expired all return { error: not_found }", async () => {
    const denied: Canvas[] = [
      canvas({ status: "archived" }),
      canvas({ status: "active", access: "private" }),
      canvas({ status: "active", access: "whole_org", sharedExpiresAt: NOW - 1 }),
    ];
    for (const cv of denied) {
      const res = await appFor(cv, other).request("/", { headers: { accept: "application/json" } });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });
});

describe("principalLookupKey — allowlist match parity", () => {
  it("normalizes a guest email to trim+lowercase so casing/whitespace never spuriously denies", () => {
    // Allowlist rows are stored trim+lowercased (allowlistAddSchema); the lookup
    // key must match that form or a legitimately-invited guest gets denied.
    expect(principalLookupKey(guest("cv1", "  Guest@Acme.COM "))).toEqual({
      email: "guest@acme.com",
    });
    expect(principalLookupKey(guest("cv1", "g@x.com"))).toEqual({ email: "g@x.com" });
  });

  it("keys a member by id and an anonymous principal by nothing", () => {
    expect(principalLookupKey(owner)).toEqual({ userId: "owner" });
    expect(principalLookupKey(anon)).toEqual({});
  });
});

// --- Internal capture principal (plan 004 / U3, §12.0) ---

describe("decideCanvasAccess — internal capture principal", () => {
  const capture = (canvasId = "cv1"): Principal => ({
    kind: "capture",
    canvasId,
    versionId: "v1",
  });

  it("allows capture of its OWN canvas at every access rung (private/gated included)", () => {
    for (const access of ["private", "specific_people", "whole_org", "public_link"] as const) {
      expect(decideCanvasAccess(canvas({ access }), capture("cv1"), NOW)).toEqual({
        action: "allow",
        needsPasswordGate: false,
        staticOnly: false,
      });
    }
  });

  it("captures full view even when a password gate is set (owner-equivalent, no prompt)", () => {
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", passwordHash: "h" }), capture("cv1"), NOW),
    ).toEqual({ action: "allow", needsPasswordGate: false, staticOnly: false });
  });

  it("DENIES a capture credential scoped to a DIFFERENT canvas (no cross-canvas render)", () => {
    // Even against an otherwise-public canvas, a token minted for cv1 cannot render cv2.
    expect(decideCanvasAccess(canvas({ id: "cv2", access: "public_link" }), capture("cv1"), NOW, {
      publicEnabled: true,
    })).toEqual({ action: "deny", status: 404, reason: "not_found" });
    expect(decideCanvasAccess(canvas({ id: "cv2", access: "private" }), capture("cv1"), NOW)).toEqual(
      { action: "deny", status: 404, reason: "not_found" },
    );
  });

  it("does NOT bypass deleted/archived/disabled (lifecycle is honored first)", () => {
    expect(decideCanvasAccess(canvas({ status: "deleted" }), capture("cv1"), NOW).action).toBe(
      "deny",
    );
    expect(decideCanvasAccess(canvas({ status: "archived" }), capture("cv1"), NOW).action).toBe(
      "deny",
    );
    expect(decideCanvasAccess(canvas({ status: "disabled" }), capture("cv1"), NOW)).toEqual({
      action: "deny",
      status: 403,
      reason: "disabled",
    });
  });
});

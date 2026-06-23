import type { Canvas } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { AppEnv, Principal } from "../http/types.js";
import {
  canvasAccess,
  decideCanvasAccess,
  isAnonymouslyPublic,
  principalLookupKey,
} from "./authorization.js";

const NOW = 1_000_000;

/** Build a canvas row with sensible defaults; override per test. */
function canvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    id: "cv1",
    slug: "s",
    slugCustom: false,
    title: "",
    description: null,
    ownerId: "owner",
    orgId: null,
    access: "private",
    sharedExpiresAt: null,
    galleryListed: false,
    galleryTemplatable: false,
    tags: null,
    galleryFeatured: false,
    searchText: null,
    galleryPublishedAt: null,
    passwordHash: null,
    passwordVersion: 0,
    spaFallback: false,
    previewMode: "auto",
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
    viewCount: 0,
    lastViewedAt: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides,
  };
}

// Inferred (not annotated `: Principal`) so they stay assignable both to `Principal`
// params and to the `{ id, isAdmin }` shape `appFor` sets as the user. The two orgs let
// the U4 truth table exercise same-org vs cross-org. `other`/`admin` are members of
// ORG_A; whole_org canvases set orgId: ORG_A to match. `owner` keeps ∅ — the owner bypass
// fires before the rung, so its membership is irrelevant.
const ORG_A = "org-A";
const ORG_B = "org-B";
const owner = { kind: "member" as const, id: "owner", isAdmin: false, orgIds: new Set<string>() };
const other = { kind: "member" as const, id: "other", isAdmin: false, orgIds: new Set([ORG_A]) };
const admin = { kind: "member" as const, id: "admin", isAdmin: true, orgIds: new Set([ORG_A]) };
const memberB = { kind: "member" as const, id: "mb", isAdmin: false, orgIds: new Set([ORG_B]) };
// Tenancy-active access context (plan 002 U4). Without this, the whole_org re-scope is
// INERT (legacy "any signed-in member") — most existing tests deliberately run inert.
const ACTIVE = { tenancyActive: true } as const;
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

  it("expired share: 404 to a same-org member once past sharedExpiresAt", () => {
    expect(
      decideCanvasAccess(
        canvas({ access: "whole_org", orgId: ORG_A, sharedExpiresAt: NOW - 1 }),
        other,
        NOW,
      ),
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
    const cv = canvas({ access: "whole_org", orgId: ORG_A });
    expect(decideCanvasAccess(cv, guest("cv1"), NOW)).toMatchObject({ status: 404 });
    expect(decideCanvasAccess(cv, anon, NOW)).toMatchObject({ status: 404 });
  });

  it("active tenancy: whole_org of org A is 404 to a member of a DIFFERENT org B (plan 002 U4)", () => {
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", orgId: ORG_A }), memberB, NOW, ACTIVE),
    ).toEqual({ action: "deny", status: 404, reason: "owner_only" });
  });

  it("active tenancy: whole_org with a NULL org_id is an explicit 404 even to a member (cutover footgun)", () => {
    // A personal/guest-owned whole_org row (org_id null) is never broadly visible —
    // don't rely on Set.has(null). The cutover clamps these to private; this is the seam.
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", orgId: null }), other, NOW, ACTIVE),
    ).toEqual({ action: "deny", status: 404, reason: "owner_only" });
  });

  it("INERT tenancy: any signed-in member reaches whole_org regardless of org (legacy, pre-cutover)", () => {
    // The safety property — deploying the re-scope changes nothing until an org is named.
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", orgId: null }), memberB, NOW),
    ).toMatchObject({ action: "allow" });
  });

  // ---- team rung (plan 003 U4): members of a granted team only ----
  const TEAM_OK = { tenancyActive: true, teamMatch: true } as const;
  const TEAM_NO = { tenancyActive: true, teamMatch: false } as const;

  it("team: a matched member (granted team + live org) is allowed", () => {
    expect(
      decideCanvasAccess(canvas({ access: "team", orgId: ORG_A }), other, NOW, TEAM_OK),
    ).toMatchObject({ action: "allow", staticOnly: false });
  });

  it("team: a member who is NOT in a granted team is 404 (teamMatch false)", () => {
    expect(
      decideCanvasAccess(canvas({ access: "team", orgId: ORG_A }), other, NOW, TEAM_NO),
    ).toMatchObject({ status: 404, reason: "owner_only" });
  });

  it("team: a guest / anonymous is 404 (outsiders never match a team)", () => {
    const cv = canvas({ id: "cvT", access: "team", orgId: ORG_A });
    expect(decideCanvasAccess(cv, guest("cvT"), NOW, TEAM_OK)).toMatchObject({ status: 404 });
    expect(decideCanvasAccess(cv, anon, NOW, TEAM_OK)).toMatchObject({ status: 404 });
  });

  // plan 003 phase 3: `teamMatch` is now the sole gate — it encodes the personal-vs-org rule
  // and membership — so a team canvas is allowed wherever teamMatch is true, regardless of the
  // canvas's org or tenancy state. (Org teams still resolve teamMatch=false under inert tenancy,
  // because the viewer has no orgIds — but that's the repo's job, not this decision table's.)
  it("team: a matched member is allowed even under INERT tenancy (teamMatch is the gate)", () => {
    expect(
      decideCanvasAccess(canvas({ access: "team", orgId: ORG_A }), other, NOW, { teamMatch: true }),
    ).toMatchObject({ action: "allow" });
  });

  it("team: a NULL org_id (PERSONAL canvas) is allowed with a teamMatch (personal team)", () => {
    expect(
      decideCanvasAccess(canvas({ access: "team", orgId: null }), other, NOW, TEAM_OK),
    ).toMatchObject({ action: "allow", staticOnly: false });
  });

  it("team: a matched member past the share expiry is 404 (share_expired)", () => {
    expect(
      decideCanvasAccess(
        canvas({ access: "team", orgId: ORG_A, sharedExpiresAt: NOW - 1 }),
        other,
        NOW,
        TEAM_OK,
      ),
    ).toMatchObject({ status: 404, reason: "share_expired" });
  });

  it("team: the OWNER is allowed by the owner bypass, regardless of teamMatch", () => {
    expect(
      decideCanvasAccess(canvas({ access: "team", orgId: ORG_A }), owner, NOW, TEAM_NO),
    ).toMatchObject({ action: "allow" });
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

  it("active tenancy: admin reaches whole_org (as a SAME-ORG member) and FACES its password gate", () => {
    // Admins get no password bypass on canvases they don't own — treated as a member.
    // And no cross-org bypass: the admin only reaches it because they're in ORG_A.
    expect(
      decideCanvasAccess(
        canvas({ access: "whole_org", orgId: ORG_A, passwordHash: "h" }),
        admin,
        NOW,
        ACTIVE,
      ),
    ).toEqual({ action: "allow", needsPasswordGate: true, staticOnly: false });
    // …and no gate when the canvas has no password.
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", orgId: ORG_A }), admin, NOW, ACTIVE),
    ).toMatchObject({ action: "allow", needsPasswordGate: false });
  });

  it("active tenancy: admin is NOT a cross-org bypass — whole_org of an org the admin isn't in is 404", () => {
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", orgId: ORG_B }), admin, NOW, ACTIVE),
    ).toMatchObject({ action: "deny", status: 404 });
  });

  it("admin sees a public_link canvas static-only, like any non-owner member", () => {
    expect(
      decideCanvasAccess(canvas({ access: "public_link" }), admin, NOW, { publicEnabled: true }),
    ).toMatchObject({ action: "allow", staticOnly: true });
  });

  it("admin is 404 on an expired whole_org share, like a normal member", () => {
    expect(
      decideCanvasAccess(
        canvas({ access: "whole_org", orgId: ORG_A, sharedExpiresAt: NOW - 1 }),
        admin,
        NOW,
      ),
    ).toMatchObject({ action: "deny", reason: "share_expired" });
  });

  it("an allowlisted admin reaches a specific_people canvas (explicitly granted)", () => {
    expect(
      decideCanvasAccess(canvas({ access: "specific_people" }), admin, NOW, { isAllowed: true }),
    ).toMatchObject({ action: "allow", staticOnly: false });
  });

  it("active tenancy: a member of the canvas's home org is allowed; gate reflects the password", () => {
    expect(
      decideCanvasAccess(canvas({ access: "whole_org", orgId: ORG_A }), other, NOW, ACTIVE),
    ).toEqual({ action: "allow", needsPasswordGate: false, staticOnly: false });
    expect(
      decideCanvasAccess(
        canvas({ access: "whole_org", orgId: ORG_A, passwordHash: "h" }),
        other,
        NOW,
        ACTIVE,
      ),
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
  function appFor(
    cv: Canvas | null,
    user: { id: string; isAdmin: boolean },
    publicLinksEnabled = true,
  ) {
    const canvases = {
      async findBySlug() {
        return cv;
      },
      async isPrincipalAllowed() {
        return false;
      },
      async isOwnerPublishEnabled() {
        return true;
      },
    } as unknown as CanvasesRepository;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("canvasSlug", "s");
      c.set("user", { id: user.id, isAdmin: user.isAdmin } as never);
      await next();
    });
    app.use(
      "*",
      canvasAccess({
        canvases,
        tenancyActive: false,
        publicLinksEnabled: async () => publicLinksEnabled,
      }),
    );
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

  it("public_link stale rows are denied when the instance public-link switch is off", async () => {
    const cv = canvas({ status: "active", access: "public_link" });
    expect((await appFor(cv, other, true).request("/")).status).toBe(200);
    const res = await appFor(cv, other, false).request("/", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
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
    expect(
      decideCanvasAccess(canvas({ id: "cv2", access: "public_link" }), capture("cv1"), NOW, {
        publicEnabled: true,
      }),
    ).toEqual({ action: "deny", status: 404, reason: "not_found" });
    expect(
      decideCanvasAccess(canvas({ id: "cv2", access: "private" }), capture("cv1"), NOW),
    ).toEqual({ action: "deny", status: 404, reason: "not_found" });
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

describe("isAnonymouslyPublic — the shared-cacheable predicate", () => {
  it("true only for public_link with no password and an unexpired share", () => {
    expect(isAnonymouslyPublic("public_link", false, null, NOW)).toBe(true);
    expect(isAnonymouslyPublic("public_link", false, NOW + 1000, NOW)).toBe(true);
  });

  it("false for every auth-gated rung", () => {
    expect(isAnonymouslyPublic("private", false, null, NOW)).toBe(false);
    expect(isAnonymouslyPublic("whole_org", false, null, NOW)).toBe(false);
    expect(isAnonymouslyPublic("specific_people", false, null, NOW)).toBe(false);
  });

  it("false when password-gated, even on public_link", () => {
    expect(isAnonymouslyPublic("public_link", true, null, NOW)).toBe(false);
  });

  it("treats the expiry boundary EXACTLY like decideCanvasAccess (<= now is expired)", () => {
    // Pin the needle at exactly `now`: <= now must read as expired (matches the
    // share_expired deny in decideCanvasAccess), so an accidental `< now` would fail here.
    expect(isAnonymouslyPublic("public_link", false, NOW, NOW)).toBe(false);
    expect(isAnonymouslyPublic("public_link", false, NOW - 1, NOW)).toBe(false);
    expect(isAnonymouslyPublic("public_link", false, NOW + 1, NOW)).toBe(true);
    // And the same boundary in decideCanvasAccess denies an anon public_link viewer.
    expect(
      decideCanvasAccess(canvas({ access: "public_link", sharedExpiresAt: NOW }), anon, NOW, {
        publicEnabled: true,
      }),
    ).toMatchObject({ action: "deny", reason: "share_expired" });
  });
});

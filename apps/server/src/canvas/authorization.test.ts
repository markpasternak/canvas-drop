import type { Canvas } from "@canvas-drop/shared/db";
import { describe, expect, it } from "vitest";
import { type AccessUser, decideCanvasAccess } from "./authorization.js";

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
    apiKeyHash: "h",
    status: "active",
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

import type { Canvas } from "@canvas-drop/shared/db";
import { describe, expect, it } from "vitest";
import { type CanvasSettingsInput, resolveSettingsUpdate } from "./settings-update.js";

const NOW = 1_700_000_000_000;

/**
 * Pure-function unit tests for the listability invariant + share/gallery
 * preconditions (review server-canvas-4). resolveSettingsUpdate is the single
 * source of truth behind both the management PATCH route and the MCP
 * update_canvas tool, so every denial branch — including NOT_PUBLISHED and
 * PASSWORD_PROTECTED, which the route-level suites only exercise indirectly —
 * gets an explicit test here. No I/O.
 */

/** A published, shared (whole_org), unprotected canvas — the gallery-eligible base. */
function canvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    id: "cv1",
    slug: "s",
    slugCustom: false,
    title: "Title",
    description: null,
    ownerId: "owner",
    orgId: null,
    access: "whole_org",
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

const PUBLIC_OK = { canPublishPublic: true, publicEdgeCacheTtlSec: 300, now: NOW };
const PUBLIC_DENIED = { canPublishPublic: false, publicEdgeCacheTtlSec: 300, now: NOW };

function resolve(cv: Canvas, input: CanvasSettingsInput, opts = PUBLIC_OK) {
  return resolveSettingsUpdate(cv, input, opts);
}

describe("resolveSettingsUpdate — denial paths", () => {
  it("SHARE_REQUIRES_PUBLISH: sharing an unpublished canvas is rejected (409)", () => {
    const r = resolve(canvas({ access: "private", currentVersionId: null }), {
      access: "whole_org",
    });
    expect(r).toMatchObject({ ok: false, code: "SHARE_REQUIRES_PUBLISH", status: 409 });
  });

  it("SHARE_REQUIRES_PUBLISH: an archived canvas (with a version) is not 'published'", () => {
    const r = resolve(canvas({ access: "private", status: "archived" }), { access: "whole_org" });
    expect(r).toMatchObject({ ok: false, code: "SHARE_REQUIRES_PUBLISH", status: 409 });
  });

  it("PUBLIC_NOT_ALLOWED: public_link without the admin grant is rejected (403)", () => {
    const r = resolve(canvas(), { access: "public_link" }, PUBLIC_DENIED);
    expect(r).toMatchObject({ ok: false, code: "PUBLIC_NOT_ALLOWED", status: 403 });
  });

  it("NOT_SHARED: listing a private canvas is rejected (409)", () => {
    const r = resolve(canvas({ access: "private" }), { galleryListed: true });
    expect(r).toMatchObject({ ok: false, code: "NOT_SHARED", status: 409 });
  });

  it("NOT_PUBLISHED: listing a shared-but-unpublished canvas is rejected (409)", () => {
    // Already shared (so NOT_SHARED doesn't fire) but never published.
    const r = resolve(canvas({ currentVersionId: null }), { galleryListed: true });
    expect(r).toMatchObject({ ok: false, code: "NOT_PUBLISHED", status: 409 });
  });

  it("PASSWORD_PROTECTED: listing while a password stays set is rejected (409)", () => {
    const r = resolve(canvas({ passwordHash: "argon2-hash" }), { galleryListed: true });
    expect(r).toMatchObject({ ok: false, code: "PASSWORD_PROTECTED", status: 409 });
  });

  it("PASSWORD_PROTECTED: listing while ADDING a password in the same patch is rejected", () => {
    const r = resolve(canvas(), { galleryListed: true, password: "hunter2" });
    expect(r).toMatchObject({ ok: false, code: "PASSWORD_PROTECTED", status: 409 });
  });

  it("NOT_LISTED: enabling templatable without the canvas being listed is rejected (409)", () => {
    const r = resolve(canvas(), { galleryTemplatable: true });
    expect(r).toMatchObject({ ok: false, code: "NOT_LISTED", status: 409 });
  });
});

describe("resolveSettingsUpdate — happy paths + invariant enforcement", () => {
  it("lists a published, shared, unprotected canvas", () => {
    const r = resolve(canvas(), { galleryListed: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.galleryListed).toBe(true);
  });

  it("lists + templatable together when all preconditions hold", () => {
    const r = resolve(canvas(), { galleryListed: true, galleryTemplatable: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.galleryListed).toBe(true);
      expect(r.patch.galleryTemplatable).toBe(true);
    }
  });

  it("removing the password (null) clears the protection so listing is allowed", () => {
    const r = resolve(canvas({ passwordHash: "argon2-hash" }), {
      galleryListed: true,
      password: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.galleryListed).toBe(true);
      expect(r.password).toBeNull();
    }
  });

  it("setting a password un-lists AND clears the gallery tags (keeps the description)", () => {
    const cv = canvas({ galleryListed: true, description: "s", tags: ["a"] });
    const r = resolve(cv, { password: "hunter2" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.galleryListed).toBe(false);
      expect(r.patch.galleryTemplatable).toBe(false);
      // The unified description (U21) is the canvas's own overview field, not gallery-only,
      // so it survives a password-set; only the gallery listing + tags are reset.
      expect(r.patch.description).toBeUndefined();
      expect(r.patch.tags).toBeNull();
    }
  });

  it("going private un-lists but KEEPS the description/tags (re-sharing restores them)", () => {
    const cv = canvas({ galleryListed: true, description: "s", tags: ["a"] });
    const r = resolve(cv, { access: "private" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.galleryListed).toBe(false);
      expect(r.patch.galleryTemplatable).toBe(false);
      // Description/tags are NOT cleared on going-private (tags only on setting a password).
      expect(r.patch.description).toBeUndefined();
      expect(r.patch.tags).toBeUndefined();
      expect(r.targetAccess).toBe("private");
    }
  });

  it("deprecated `shared: true` boolean maps to whole_org", () => {
    const r = resolve(canvas({ access: "private" }), { shared: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetAccess).toBe("whole_org");
  });

  it("deprecated `shared: false` boolean maps to private", () => {
    const r = resolve(canvas(), { shared: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetAccess).toBe("private");
  });

  it("public_link with the admin grant is allowed", () => {
    const r = resolve(canvas(), { access: "public_link" }, PUBLIC_OK);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetAccess).toBe("public_link");
  });

  it("a no-op patch leaves access unchanged (targetAccess undefined)", () => {
    const r = resolve(canvas(), { title: "Renamed" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetAccess).toBeUndefined();
  });
});

/** A published, anonymously-public (public_link, no password, unexpired) canvas. */
function publicCanvas(over: Partial<Canvas> = {}): Canvas {
  return {
    access: "public_link",
    passwordHash: null,
    status: "active",
    currentVersionId: "v1",
    sharedExpiresAt: null,
    galleryListed: false,
    galleryTemplatable: false,
    ...over,
  } as Canvas;
}

const cdnOpts = { canPublishPublic: true, publicEdgeCacheTtlSec: 300, now: NOW };

describe("resolveSettingsUpdate — CDN downgrade warning", () => {
  it("warns when a public canvas is restricted, quoting the TTL in human terms", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { access: "private" }, cdnOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toContain("about 5 minutes");
  });

  it("warns when a password is added to a public canvas (now gated)", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { password: "hunter2" }, cdnOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/CDN/);
  });

  it("does NOT warn when edge caching is off (TTL 0)", () => {
    const r = resolveSettingsUpdate(
      publicCanvas(),
      { access: "private" },
      { ...cdnOpts, publicEdgeCacheTtlSec: 0 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("does NOT warn on an upgrade TO public (was never edge-cacheable)", () => {
    const r = resolveSettingsUpdate(
      publicCanvas({ access: "private", currentVersionId: "v1" }),
      { access: "public_link" },
      cdnOpts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("does NOT warn when the canvas stays public (unrelated edit)", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { title: "New title" }, cdnOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("warns when a public canvas is restricted via a past sharedExpiresAt", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { sharedExpiresAt: NOW - 1 }, cdnOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toContain("about 5 minutes");
  });

  it("does NOT warn when setting a FUTURE expiry (still publicly reachable)", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { sharedExpiresAt: NOW + 3_600_000 }, cdnOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("does NOT warn restricting an already-expired public canvas (was not anon-public)", () => {
    const r = resolveSettingsUpdate(
      publicCanvas({ sharedExpiresAt: NOW - 1 }),
      { access: "private" },
      cdnOpts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("warns on the deprecated `shared: false` downgrade of a public canvas", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { shared: false }, cdnOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/CDN/);
  });

  it("warns when narrowing public_link to whole_org (still off the anonymous rung)", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { access: "whole_org" }, cdnOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/CDN/);
  });
});

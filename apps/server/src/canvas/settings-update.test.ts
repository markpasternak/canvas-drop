import type { Canvas } from "@canvas-drop/shared/db";
import { describe, expect, it } from "vitest";
import { resolveSettingsUpdate } from "./settings-update.js";

const NOW = 1_700_000_000_000;

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

const opts = { canPublishPublic: true, publicEdgeCacheTtlSec: 300, now: NOW };

describe("resolveSettingsUpdate — CDN downgrade warning", () => {
  it("warns when a public canvas is restricted, quoting the TTL in human terms", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { access: "private" }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toContain("about 5 minutes");
  });

  it("warns when a password is added to a public canvas (now gated)", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { password: "hunter2" }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/CDN/);
  });

  it("does NOT warn when edge caching is off (TTL 0)", () => {
    const r = resolveSettingsUpdate(
      publicCanvas(),
      { access: "private" },
      {
        ...opts,
        publicEdgeCacheTtlSec: 0,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("does NOT warn on an upgrade TO public (was never edge-cacheable)", () => {
    const r = resolveSettingsUpdate(
      publicCanvas({ access: "private", currentVersionId: "v1" }),
      { access: "public_link" },
      opts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("does NOT warn when the canvas stays public (unrelated edit)", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { title: "New title" }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("warns when a public canvas is restricted via a past sharedExpiresAt", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { sharedExpiresAt: NOW - 1 }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toContain("about 5 minutes");
  });

  it("does NOT warn when setting a FUTURE expiry (still publicly reachable)", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { sharedExpiresAt: NOW + 3_600_000 }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("does NOT warn restricting an already-expired public canvas (was not anon-public)", () => {
    const r = resolveSettingsUpdate(
      publicCanvas({ sharedExpiresAt: NOW - 1 }),
      { access: "private" },
      opts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("warns on the deprecated `shared: false` downgrade of a public canvas", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { shared: false }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/CDN/);
  });

  it("warns when narrowing public_link to whole_org (still off the anonymous rung)", () => {
    const r = resolveSettingsUpdate(publicCanvas(), { access: "whole_org" }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/CDN/);
  });
});

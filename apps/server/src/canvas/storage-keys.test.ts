import { describe, expect, it } from "vitest";
import {
  blobKey,
  canvasBlobPrefix,
  hashFromBlobKey,
  SCREENSHOT_RENDITIONS,
  screenshotKey,
  screenshotPrefix,
} from "./storage-keys.js";

describe("content-addressed storage keys (M5)", () => {
  const canvasId = "0190a000-0000-7000-8000-000000000001";
  const hash = "a".repeat(64);

  it("blobKey nests the hash under the canvas blob prefix", () => {
    expect(blobKey(canvasId, hash)).toBe(`canvases/${canvasId}/blobs/${hash}`);
    expect(blobKey(canvasId, hash).startsWith(canvasBlobPrefix(canvasId))).toBe(true);
  });

  it("blobs are flat under the prefix (a hash never introduces nesting)", () => {
    const key = blobKey(canvasId, hash);
    // Exactly one path segment after the prefix.
    expect(key.slice(canvasBlobPrefix(canvasId).length)).toBe(hash);
    expect(key.slice(canvasBlobPrefix(canvasId).length).includes("/")).toBe(false);
  });

  it("hashFromBlobKey round-trips blobKey", () => {
    expect(hashFromBlobKey(canvasId, blobKey(canvasId, hash))).toBe(hash);
  });

  it("prefixes are canvas-scoped (no cross-canvas overlap)", () => {
    const other = "0190a000-0000-7000-8000-000000000002";
    expect(canvasBlobPrefix(canvasId)).not.toBe(canvasBlobPrefix(other));
    expect(blobKey(canvasId, hash).startsWith(canvasBlobPrefix(other))).toBe(false);
  });
});

describe("screenshot storage keys (plan 004, KTD-6 — one preview per canvas)", () => {
  const canvasId = "0190a000-0000-7000-8000-000000000001";

  it("screenshotKey is canvas-stable (no versionId) so a republish overwrites", () => {
    expect(screenshotKey(canvasId, "og")).toBe(`screenshots/${canvasId}/og.webp`);
    expect(screenshotKey(canvasId, "card")).toBe(`screenshots/${canvasId}/card.webp`);
    expect(screenshotKey(canvasId, "thumb")).toBe(`screenshots/${canvasId}/thumb.webp`);
  });

  it("every rendition key sits directly under the canvas prefix", () => {
    for (const r of SCREENSHOT_RENDITIONS) {
      const key = screenshotKey(canvasId, r);
      expect(key.startsWith(screenshotPrefix(canvasId))).toBe(true);
      // exactly one segment (the rendition file) after the prefix
      expect(key.slice(screenshotPrefix(canvasId).length).includes("/")).toBe(false);
    }
  });

  it("is disjoint from the content blob prefix (GC must never overlap)", () => {
    expect(screenshotPrefix(canvasId).startsWith(canvasBlobPrefix(canvasId))).toBe(false);
    expect(canvasBlobPrefix(canvasId).startsWith(screenshotPrefix(canvasId))).toBe(false);
    expect(screenshotKey(canvasId, "og").startsWith(canvasBlobPrefix(canvasId))).toBe(false);
  });
});

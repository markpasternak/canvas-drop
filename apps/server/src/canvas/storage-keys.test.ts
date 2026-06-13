import { describe, expect, it } from "vitest";
import { blobKey, canvasBlobPrefix, hashFromBlobKey } from "./storage-keys.js";

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

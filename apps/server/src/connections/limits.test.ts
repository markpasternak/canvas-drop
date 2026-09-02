import { describe, expect, it } from "vitest";
import { connectionLimits } from "./limits.js";

const input = (actorId = "u1", canvasId = "c1", profileId = "p1") => ({
  actorId,
  canvasId,
  profileId,
});

describe("connectionLimits", () => {
  it("enforces and releases per-canvas and instance concurrency", () => {
    const limits = connectionLimits({
      actorPerMin: 100,
      profilePerMin: 100,
      canvasConcurrency: 1,
      instanceConcurrency: 2,
    });
    const first = limits.acquire(input());
    expect(() => limits.acquire(input("u2"))).toThrowError(
      expect.objectContaining({ code: "CONNECTION_LIMIT" }),
    );
    const second = limits.acquire(input("u2", "c2"));
    expect(() => limits.acquire(input("u3", "c3"))).toThrowError(
      expect.objectContaining({ code: "CONNECTION_LIMIT" }),
    );
    first.release();
    first.release();
    expect(() => limits.acquire(input("u3", "c3"))).not.toThrow();
    second.release();
  });

  it("keys actor rate by actor/canvas/profile and profile rate instance-wide", () => {
    let now = 1_000_000;
    const limits = connectionLimits(
      { actorPerMin: 1, profilePerMin: 3, canvasConcurrency: 10, instanceConcurrency: 10 },
      () => now,
    );
    limits.acquire(input()).release();
    expect(() => limits.acquire(input())).toThrowError(
      expect.objectContaining({ code: "CONNECTION_RATE_LIMIT" }),
    );
    limits.acquire(input("u1", "c2")).release();
    limits.acquire(input("u2", "c1")).release();
    expect(() => limits.acquire(input("u3", "c3"))).toThrowError(
      expect.objectContaining({ code: "CONNECTION_RATE_LIMIT" }),
    );
    now += 60_001;
    expect(() => limits.acquire(input())).not.toThrow();
  });
});

import { describe, expect, it, vi } from "vitest";

// A cheap stand-in for argon2 so the concurrency bound is testable without paying
// 64 MiB per verify. Each verify resolves after a short delay.
vi.mock("@node-rs/argon2", () => ({
  hash: async () => "stub-hash",
  verify: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20)),
}));

const { MAX_CONCURRENT_VERIFIES, MAX_QUEUED_VERIFIES, PasswordCheckBusy, verifyPassword } =
  await import("./password.js");

describe("verifyPassword concurrency bound", () => {
  it("runs a bounded number at once, queues a few, and refuses the overflow as busy", async () => {
    const overflow = 3;
    const total = MAX_CONCURRENT_VERIFIES + MAX_QUEUED_VERIFIES + overflow;
    const results = await Promise.allSettled(
      Array.from({ length: total }, () => verifyPassword("h", "pw")),
    );
    const busy = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof PasswordCheckBusy,
    );
    expect(busy).toHaveLength(overflow);
    expect(results.filter((r) => r.status === "fulfilled" && r.value === true)).toHaveLength(
      total - overflow,
    );
    // Every slot was released: a later check runs normally.
    await expect(verifyPassword("h", "pw")).resolves.toBe(true);
  });
});

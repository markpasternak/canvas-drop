import { describe, expect, it } from "vitest";
import { generateSlug, generateUniqueSlug } from "./slug.js";

describe("generateSlug", () => {
  it("produces a readable-random slug of the form adjective-noun-suffix", () => {
    const slug = generateSlug();
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{13}$/);
  });

  it("generates distinct slugs across many calls (entropy in the suffix)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateSlug());
    expect(seen.size).toBe(500); // no collisions at this scale
  });

  it("suffix carries >=64 bits (13 base32 chars × 5 bits = 65)", () => {
    const suffix = generateSlug().split("-").pop() as string;
    expect(suffix.length).toBe(13);
  });

  it("can reach every word in both lists", () => {
    // Uniformity itself is `randomInt`'s guarantee, and asserting a frequency
    // band here would just add a flaky required check. What is worth pinning is
    // reachability: an off-by-one in the index bound (the realistic bug) would
    // strand the last word, and over 20k draws a reachable word is missed with
    // probability ~(31/32)^20000 — effectively never.
    const adjectives = new Set<string>();
    const nouns = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const [adjective, noun] = generateSlug().split("-") as [string, string];
      adjectives.add(adjective);
      nouns.add(noun);
    }
    expect(adjectives.size).toBe(32);
    expect(nouns.size).toBe(32);
  });
});

describe("generateUniqueSlug", () => {
  it("retries on collision and returns a free slug", async () => {
    const taken = new Set<string>();
    const first = generateSlug();
    taken.add(first); // force the first attempt to collide
    let calls = 0;
    const slug = await generateUniqueSlug(async (s) => {
      calls++;
      // collide only on the very first proposed slug
      return calls === 1 ? true : taken.has(s);
    });
    expect(slug).toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("throws after exhausting attempts", async () => {
    await expect(generateUniqueSlug(async () => true, 3)).rejects.toThrow();
  });
});

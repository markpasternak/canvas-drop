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

  it("draws each word with equal probability", () => {
    // `pick` uses rejection sampling so this holds for any wordlist length. The
    // lists are 32 long today, where a plain `byte % len` happened to be uniform
    // too — this test is what makes that stop being luck: edit either list to a
    // length that does not divide 256 and a modulo pick would skew here.
    const counts = new Map<string, number>();
    const N = 64_000;
    for (let i = 0; i < N; i++) {
      const [adjective, noun] = generateSlug().split("-") as [string, string];
      counts.set(adjective, (counts.get(adjective) ?? 0) + 1);
      counts.set(`n:${noun}`, (counts.get(`n:${noun}`) ?? 0) + 1);
    }
    const adjectives = [...counts].filter(([w]) => !w.startsWith("n:"));
    const nouns = [...counts].filter(([w]) => w.startsWith("n:"));
    expect(adjectives.length).toBeGreaterThan(1);
    expect(nouns.length).toBeGreaterThan(1);
    for (const list of [adjectives, nouns]) {
      const expected = N / list.length;
      // Uniform draws stay well inside 10% at this sample size; the ~12% skew a
      // modulo pick puts on the low indices of a non-dividing list breaks out.
      for (const [, f] of list) expect(Math.abs(f - expected) / expected).toBeLessThan(0.1);
    }
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

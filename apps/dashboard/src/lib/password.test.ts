import { describe, expect, it } from "vitest";
import { generatePassword } from "./password.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const AMBIGUOUS = new Set(["0", "O", "1", "l", "I"]);

describe("generatePassword", () => {
  it("produces a result of length 20 by default", () => {
    expect(generatePassword()).toHaveLength(20);
  });

  it("every character is in the declared alphabet", () => {
    const pw = generatePassword();
    for (const ch of pw) {
      expect(ALPHABET.includes(ch)).toBe(true);
    }
  });

  it("contains no ambiguous characters (0, O, 1, l, I)", () => {
    const pw = generatePassword();
    for (const ch of pw) {
      expect(AMBIGUOUS.has(ch)).toBe(false);
    }
  });

  it("100 generated passwords all satisfy length, alphabet, and no-ambiguous constraints", () => {
    for (let i = 0; i < 100; i++) {
      const pw = generatePassword();
      expect(pw).toHaveLength(20);
      for (const ch of pw) {
        expect(ALPHABET.includes(ch)).toBe(true);
        expect(AMBIGUOUS.has(ch)).toBe(false);
      }
    }
  });
});

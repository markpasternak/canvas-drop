import { describe, expect, it } from "vitest";
import { generatePassword, UNAMBIGUOUS_CHARS } from "./password.js";

const AMBIGUOUS = new Set(["0", "O", "o", "1", "l", "I", "i"]);
const SHAPE = /^[a-z2-9]{4}(?:-[a-z2-9]{4}){4}$/;

describe("generatePassword", () => {
  it("produces five dash-separated groups of four by default", () => {
    expect(generatePassword()).toMatch(SHAPE);
  });

  it("is lowercase only, so case can never make a generated password fail", () => {
    for (let i = 0; i < 100; i++) {
      const pw = generatePassword();
      expect(pw).toBe(pw.toLowerCase());
    }
  });

  it("100 generated passwords use only the alphabet and no look-alike characters", () => {
    for (let i = 0; i < 100; i++) {
      const pw = generatePassword();
      expect(pw).toMatch(SHAPE);
      for (const ch of pw.replaceAll("-", "")) {
        expect(UNAMBIGUOUS_CHARS.includes(ch)).toBe(true);
        expect(AMBIGUOUS.has(ch)).toBe(false);
      }
    }
  });

  it("keeps at least ~96 bits of entropy", () => {
    const symbols = generatePassword().replaceAll("-", "").length;
    expect(symbols * Math.log2(UNAMBIGUOUS_CHARS.length)).toBeGreaterThanOrEqual(96);
  });
});

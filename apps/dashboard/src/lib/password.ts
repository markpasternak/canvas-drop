/**
 * Lowercase letters and digits minus the look-alikes (0/o, 1/l/i). Lowercase only on
 * purpose: generated passwords get read aloud, retyped from another screen, and typed
 * on phones that capitalize the first letter, and a mixed-case password fails on any
 * of those for a reason the visitor can't see. 31 symbols, ~4.95 bits each.
 */
export const UNAMBIGUOUS_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

/** A strong, shareable password such as `k7mp-x3qa-9hzt-4wce-rn2d`: five groups of four
 *  (~99 bits), dash-separated so it is easy to read back. Uses the CSPRNG with
 *  rejection sampling so the distribution stays uniform for any alphabet size. */
export function generatePassword(groups = 5, groupLength = 4): string {
  const alphabet = UNAMBIGUOUS_CHARS;
  const length = groups * groupLength;
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  const out: string[] = [];
  while (out.length < length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (out.length >= length) break;
      if (b < max) out.push(alphabet[b % alphabet.length] as string);
    }
  }
  const chunks: string[] = [];
  for (let i = 0; i < length; i += groupLength) chunks.push(out.slice(i, i + groupLength).join(""));
  return chunks.join("-");
}

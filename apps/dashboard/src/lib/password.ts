/** A strong, shareable password from an unambiguous alphabet (no 0/O/1/l/I).
 *  Uses the CSPRNG with rejection sampling so the distribution stays uniform. */
export function generatePassword(length = 20): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
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
  return out.join("");
}

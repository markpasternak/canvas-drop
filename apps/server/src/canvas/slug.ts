import { randomBytes } from "node:crypto";
import { validateSlug } from "@canvas-drop/shared";

/**
 * Readable-random slug generator (D3). The readable prefix is cosmetic; the
 * unguessability (§12.1.4) comes entirely from the random suffix, so entropy is
 * asserted on the suffix alone — independent of wordlist size.
 *
 * Suffix: 5 chars of Crockford base32 (no ambiguous I/L/O/U) = 25 bits each →
 * we use a 13-char suffix (~65 bits) split as `xxxxx-xxxxxxxx`? Keep it simple:
 * one base32 suffix giving ≥64 bits.
 */
const ADJECTIVES = [
  "quiet",
  "bright",
  "swift",
  "calm",
  "bold",
  "warm",
  "clever",
  "gentle",
  "brave",
  "lucky",
  "merry",
  "noble",
  "proud",
  "sunny",
  "witty",
  "amber",
  "azure",
  "coral",
  "ivory",
  "jade",
  "olive",
  "ruby",
  "teal",
  "violet",
  "wild",
  "fuzzy",
  "cosmic",
  "lunar",
  "solar",
  "misty",
  "frosty",
  "dusky",
];
const NOUNS = [
  "otter",
  "falcon",
  "willow",
  "cedar",
  "comet",
  "river",
  "meadow",
  "ember",
  "harbor",
  "lantern",
  "maple",
  "pebble",
  "quartz",
  "raven",
  "sparrow",
  "thistle",
  "walrus",
  "badger",
  "heron",
  "marten",
  "puffin",
  "ibis",
  "lynx",
  "koi",
  "moth",
  "newt",
  "vole",
  "wren",
  "yak",
  "zebra",
  "finch",
  "gecko",
];
// Crockford base32 alphabet (excludes I, L, O, U to avoid ambiguity).
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode random bytes into Crockford base32, lowercased. */
function randomBase32(chars: number): string {
  // 5 bits per char → need ceil(chars*5/8) bytes
  const bytes = randomBytes(Math.ceil((chars * 5) / 8));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.toLowerCase();
}

function pick<T>(arr: readonly T[]): T {
  // unbiased index from a random byte pool
  const idx = randomBytes(1)[0] as number;
  return arr[idx % arr.length] as T;
}

/** ≥64 bits of entropy: 13 base32 chars × 5 bits = 65 bits. */
const SUFFIX_CHARS = 13;

/** Generate a readable-random slug like `quiet-otter-x7k2m9...`. */
export function generateSlug(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomBase32(SUFFIX_CHARS)}`;
}

/**
 * Generate a slug not already taken, retrying on collision. `exists` is the
 * caller's uniqueness check (the slug index).
 */
export async function generateUniqueSlug(
  exists: (slug: string) => Promise<boolean>,
  maxAttempts = 8,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const slug = generateSlug();
    if (!(await exists(slug))) return slug;
  }
  throw new Error("could not generate a unique slug after retries");
}

/**
 * Resolve a create/rename slug: a trimmed non-empty `raw` is validated as a CUSTOM
 * slug (grammar + reserved-word check; uniqueness is the caller's DB concern), an
 * empty/absent `raw` mints a fresh random one. Shared by the management create/rename
 * routes and the MCP tools so the two can't diverge on slug policy.
 */
export async function resolveCreateSlug(
  raw: string | undefined,
  exists: (slug: string) => Promise<boolean>,
): Promise<{ slug: string; custom: boolean } | { error: "invalid_slug" }> {
  const trimmed = raw?.trim();
  if (trimmed) {
    const check = validateSlug(trimmed);
    if (!check.ok) return { error: "invalid_slug" };
    return { slug: trimmed, custom: true };
  }
  return { slug: await generateUniqueSlug(exists), custom: false };
}

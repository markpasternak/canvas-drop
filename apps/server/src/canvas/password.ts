import { hash, verify } from "@node-rs/argon2";

/**
 * Canvas password hashing (§12.1.3) via argon2id (`@node-rs/argon2`, Rust native
 * binding — pure-JS is ~100× slower). OWASP 2026 params: t=3, m=64 MiB, p=1
 * (~100ms/verify). Used by the settings route (U14) and the gate (U16).
 */
const PARAMS = { memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    // malformed hash / verify error → not a match
    return false;
  }
}

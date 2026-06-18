import { hash, verify } from "@node-rs/argon2";
import type { Logger } from "../log/logger.js";

/**
 * Canvas password hashing (§12.1.3) via argon2id (`@node-rs/argon2`, Rust native
 * binding — pure-JS is ~100× slower). OWASP 2026 params: t=3, m=64 MiB, p=1
 * (~100ms/verify). Used by the settings route (U14) and the gate (U16).
 */
const PARAMS = { memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

export async function verifyPassword(
  storedHash: string,
  password: string,
  log?: Logger,
): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch (err) {
    // A malformed/corrupt hash or a system-level argon2 failure both surface here.
    // Returning false keeps a verify failure from leaking as a 500, but a system-level
    // failure must not be invisible — it would otherwise be audited as a plain
    // wrong-password attempt, masking infra problems (review server-canvas-17).
    log?.warn({ err }, "argon2 password verify failed — treating as no match");
    return false;
  }
}

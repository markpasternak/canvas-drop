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

/** Preserve an omitted password, clear an explicit null, or hash a replacement. */
export function hashPasswordMutation(
  password: string | null | undefined,
): Promise<string> | null | undefined {
  if (password === undefined) return undefined;
  if (password === null) return null;
  return hashPassword(password);
}

/**
 * Process-wide bound on concurrent verifies. Each one costs ~100 ms of CPU and 64 MiB,
 * and the gate accepts them from anonymous visitors, so the per-requester throttle
 * alone doesn't bound the total. A short queue absorbs bursts; past it, callers are
 * told to retry rather than piling up work.
 */
export const MAX_CONCURRENT_VERIFIES = 4;
export const MAX_QUEUED_VERIFIES = 32;

/** Thrown by {@link verifyPassword} when the verify queue is full. */
export class PasswordCheckBusy extends Error {
  constructor() {
    super("too many password checks in progress");
  }
}

let activeVerifies = 0;
const waitingVerifies: Array<() => void> = [];

async function acquireVerifySlot(): Promise<void> {
  if (activeVerifies < MAX_CONCURRENT_VERIFIES) {
    activeVerifies += 1;
    return;
  }
  if (waitingVerifies.length >= MAX_QUEUED_VERIFIES) throw new PasswordCheckBusy();
  // The releasing caller hands its slot over directly (activeVerifies is unchanged).
  await new Promise<void>((resolve) => waitingVerifies.push(resolve));
}

function releaseVerifySlot(): void {
  const next = waitingVerifies.shift();
  if (next) next();
  else activeVerifies -= 1;
}

export async function verifyPassword(
  storedHash: string,
  password: string,
  log?: Logger,
): Promise<boolean> {
  await acquireVerifySlot();
  try {
    return await verify(storedHash, password);
  } catch (err) {
    // A malformed/corrupt hash or a system-level argon2 failure both surface here.
    // Returning false keeps a verify failure from leaking as a 500, but a system-level
    // failure must not be invisible — it would otherwise be audited as a plain
    // wrong-password attempt, masking infra problems (review server-canvas-17).
    log?.warn({ err }, "argon2 password verify failed — treating as no match");
    return false;
  } finally {
    releaseVerifySlot();
  }
}

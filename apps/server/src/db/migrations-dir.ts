import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolve the absolute path to a dialect's migrations folder by walking up from
 * the current working directory until a `drizzle/<dialect>` directory is found.
 *
 * This makes migration loading robust regardless of where the process starts —
 * the repo root (tests, `pnpm test`), `apps/server` (`pnpm dev` via --filter), or
 * a built image (migrations copied alongside). Falls back to the cwd-relative
 * path if none is found, so the error message still points somewhere sensible.
 */
export function resolveMigrationsDir(dialect: "sqlite" | "pg"): string {
  const rel = `drizzle/${dialect}`;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), rel);
}

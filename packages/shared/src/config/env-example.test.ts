import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./env.js";

// Drift guard (U3): the shipped env examples must stay in lockstep with the config
// schema. If a variable is renamed/removed or an example value becomes invalid,
// `loadConfig` throws here — long before a self-hoster hits it. The production
// example must also be a *complete, valid* prod config (validator-valid, fake
// placeholders), so copy-and-replace yields a booting instance.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const envSource = readFileSync(resolve(here, "env.ts"), "utf8");

/** Active `KEY=VALUE` lines from an env-example file (skips blanks, comments, inline comments). */
function parseEnvExample(relPath: string): Record<string, string> {
  const text = readFileSync(resolve(repoRoot, relPath), "utf8");
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    const value = line
      .slice(eq + 1)
      .replace(/\s+#.*$/, "") // strip trailing inline comment
      .trim();
    env[key] = value;
  }
  return env;
}

/** Keys the config schema knows about (referenced anywhere in env.ts). */
const knownKeys = new Set(envSource.match(/CANVAS_DROP_[A-Z0-9_]+/g) ?? []);
const alwaysKnown = new Set(["NODE_ENV", "LOG_LEVEL", "LOG_FORMAT"]);

describe.each([".env.example", ".env.production.example"])("%s", (file) => {
  const env = parseEnvExample(file);

  it("loads through the config validator without throwing", () => {
    expect(() => loadConfig(env)).not.toThrow();
  });

  it("contains no env keys the config schema doesn't recognize (drift guard)", () => {
    const unknown = Object.keys(env).filter((k) => !knownKeys.has(k) && !alwaysKnown.has(k));
    expect(unknown).toEqual([]);
  });
});

describe(".env.production.example", () => {
  const config = loadConfig(parseEnvExample(".env.production.example"));

  it("describes the blessed production profile (subdomain · proxy/JWKS · postgres · s3)", () => {
    expect(config.urlMode).toBe("subdomain");
    expect(config.auth.mode).toBe("proxy");
    expect(config.auth.proxy.jwksUrl).toBeTruthy();
    expect(config.db.driver).toBe("postgres");
    expect(config.storage.driver).toBe("s3");
    expect(config.isProduction).toBe(true);
  });
});

import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv, Principal } from "../http/types.js";
import { captureResolver } from "./capture-resolver.js";
import { CAPTURE_TOKEN_HEADER, mintCaptureToken } from "./capture-token.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const SECRET = config.sessionSecret;
const CANVAS = "0190a000-0000-7000-8000-000000000001";
const VERSION = "0190b000-0000-7000-8000-0000000000a1";

/** Mount the resolver + a terminal handler that reports the resolved principal. */
function app() {
  const a = new Hono<AppEnv>();
  a.use("*", captureResolver({ config, secret: SECRET }));
  a.get("*", (c) => c.json({ principal: (c.get("principal") as Principal | undefined) ?? null }));
  return a;
}

const principalFor = async (path: string, headers: Record<string, string> = {}) => {
  const res = await app().request(path, { headers: { host: "localhost", ...headers } });
  const body = (await res.json()) as { principal: Principal | null };
  return body.principal;
};

describe("captureResolver (plan 004 / U5, §12.0)", () => {
  // Rejection paths first (auth-invariant checklist).
  it("sets NO principal when the capture header is absent", async () => {
    expect(await principalFor("/c/test-slug/")).toBeNull();
  });

  it("sets NO principal for an invalid/forged token (a client can't forge the HMAC)", async () => {
    expect(
      await principalFor("/c/test-slug/", { [CAPTURE_TOKEN_HEADER]: "not-a-real-token" }),
    ).toBeNull();
    const wrongSecret = mintCaptureToken(
      "a-different-secret-32-chars-minimum!",
      CANVAS,
      VERSION,
      60_000,
    );
    expect(await principalFor("/c/test-slug/", { [CAPTURE_TOKEN_HEADER]: wrongSecret })).toBeNull();
  });

  it("sets NO principal on a non-canvas surface even with a valid token", async () => {
    const token = mintCaptureToken(SECRET, CANVAS, VERSION, 60_000);
    // A dashboard/management path is not a canvas surface — the carve-out must not fire.
    expect(await principalFor("/api/canvases", { [CAPTURE_TOKEN_HEADER]: token })).toBeNull();
  });

  // Happy path.
  it("sets the capture principal (scoped to the token's canvas+version) on a valid token", async () => {
    const token = mintCaptureToken(SECRET, CANVAS, VERSION, 60_000);
    const p = await principalFor("/c/test-slug/", { [CAPTURE_TOKEN_HEADER]: token });
    expect(p).toEqual({ kind: "capture", canvasId: CANVAS, versionId: VERSION });
  });
});

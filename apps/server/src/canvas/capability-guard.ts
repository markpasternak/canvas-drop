import {
  type Capability,
  type CapabilityGlobals,
  type Config,
  isCapabilityEnabled,
} from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../http/types.js";

/**
 * Capability runtime guard (plan 006). This is the seam the future backend
 * primitives (KV/Files/AI/Realtime in M6/M9, and the runtime `me()` identity
 * endpoint) plug into: each primitive route group runs `requireCapability(cap,
 * config)` after `canvasAccess` (U15) has resolved + authorized the canvas, and
 * gets a typed 403 when the capability is off.
 *
 * No primitive routes exist yet — this module ships the guard and its tests so
 * the primitives are a thin handler behind one shared check rather than
 * scattered, retrofitted gating.
 */

/** Stable error body returned when a capability is disabled (maps to a typed SDK error). */
export const CAPABILITY_DISABLED = "CAPABILITY_DISABLED" as const;

/** Translate the server Config into the narrow globals the capability rule needs. */
export function capabilityGlobals(config: Config): CapabilityGlobals {
  return {
    realtimeEnabled: config.realtimeEnabled,
    // Truthy check (not `!== undefined`): an empty-string key must not enable AI.
    // Config also coerces a blank key to undefined; this is belt-and-suspenders.
    aiEnabled: !!config.ai.apiKey,
  };
}

/** Pure check: is `capability` effective for this canvas under the given config? */
export function assertCapability(canvas: Canvas, capability: Capability, config: Config): boolean {
  return isCapabilityEnabled(canvas, capability, capabilityGlobals(config));
}

/**
 * Per-request overrides for the operator globals. The AI key and realtime switch
 * are admin-tunable at runtime (DB overrides env), so those globals are resolved
 * per request instead of baked from boot config. Omitted → use the config value.
 */
export interface CapabilityGlobalOverrides {
  aiEnabled?: () => Promise<boolean>;
  realtimeEnabled?: () => Promise<boolean>;
}

/**
 * Middleware factory. Must run AFTER `canvasAccess` populates `c.get("canvas")`.
 * Returns 403 `CAPABILITY_DISABLED` when the capability is off for the resolved
 * canvas; 500 if wired before the canvas is resolved (a programming error, not a
 * client one).
 */
export function requireCapability(
  capability: Capability,
  config: Config,
  overrides?: CapabilityGlobalOverrides,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const canvas = c.get("canvas");
    if (!canvas) {
      // Contract violation: requireCapability ran before canvasAccess.
      c.get("log")?.error(
        { capability },
        "requireCapability ran without a resolved canvas in context",
      );
      return c.json({ error: "canvas_not_resolved" }, 500);
    }
    const globals = capabilityGlobals(config);
    // Resolve the admin-tunable globals per request when a resolver is wired.
    if (overrides?.aiEnabled) globals.aiEnabled = await overrides.aiEnabled();
    if (overrides?.realtimeEnabled) globals.realtimeEnabled = await overrides.realtimeEnabled();
    if (!isCapabilityEnabled(canvas, capability, globals)) {
      return c.json({ code: CAPABILITY_DISABLED, capability }, 403);
    }
    await next();
  });
}

import {
  type CanvasCapabilityState,
  type Capability,
  type CapabilityGlobals,
  type Config,
  isCapabilityEnabled,
  storedCapabilities,
} from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../http/types.js";

/**
 * Capability runtime guard (plan 006). The seam each backend primitive
 * (KV / Files / AI / Realtime, and the runtime `me()` identity endpoint —
 * all shipped in M6/M9) plugs into: each primitive route group runs
 * `requireCapability(cap, config)` after `canvasAccess` (U15) has resolved +
 * authorized the canvas, and gets a typed 403 when the capability is off — so
 * the primitives are a thin handler behind one shared check rather than
 * scattered, retrofitted gating.
 */

/** Stable error body returned when a capability is disabled (maps to a typed SDK error). */
export const CAPABILITY_DISABLED = "CAPABILITY_DISABLED" as const;

/** Why a capability is off + how to fix it, so the 403 is self-repairable (D7/§4.5). */
export interface CapabilityDisabledDetail {
  capability: Capability;
  /** The master backend switch (off by default on a new canvas). */
  backendEnabled: boolean;
  /** Which gate failed: the backend master, this feature's flag, or a deployment global. */
  reason: "backend_off" | "feature_off" | "operator_disabled";
  /** A human/agent-actionable remediation hint. */
  hint: string;
}

/**
 * Diagnose a disabled capability into a stable, actionable detail. Called only
 * when {@link isCapabilityEnabled} is already false, so exactly one gate failed;
 * the order mirrors {@link effectiveCapabilities} (backend → feature flag → global).
 * Identity is on whenever backend is on, so it can only be `backend_off`.
 */
export function capabilityDisabledDetail(
  canvas: CanvasCapabilityState,
  capability: Capability,
): CapabilityDisabledDetail {
  if (!canvas.backendEnabled) {
    return {
      capability,
      backendEnabled: false,
      reason: "backend_off",
      hint: 'This canvas\'s backend is off (the master switch, off by default). Turn it on in the dashboard Backend tab, the set_capabilities MCP tool, or PATCH /api/canvases/:id/capabilities {"backendEnabled": true}.',
    };
  }
  if (capability !== "identity" && !storedCapabilities(canvas)[capability]) {
    return {
      capability,
      backendEnabled: true,
      reason: "feature_off",
      hint: `The "${capability}" capability is off for this canvas. Enable it in the dashboard Backend tab, the set_capabilities MCP tool, or PATCH /api/canvases/:id/capabilities {"${capability}": true}.`,
    };
  }
  // Flag is on, but the operator-level global is off (ai/realtime only).
  return {
    capability,
    backendEnabled: true,
    reason: "operator_disabled",
    hint:
      capability === "ai"
        ? "AI is not configured on this deployment (no AI provider key set by the operator)."
        : capability === "realtime"
          ? "Realtime is disabled on this deployment (operator setting CANVAS_DROP_REALTIME=off)."
          : "This capability is disabled at the deployment level by the operator.",
  };
}

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
      // Enrich the 403 so an agent can repair it without prior doc knowledge
      // (D7/§4.5 — "errors agents can repair from"). `code` stays stable; the
      // added fields (backendEnabled, reason, hint) are purely additive.
      return c.json(
        { code: CAPABILITY_DISABLED, ...capabilityDisabledDetail(canvas, capability) },
        403,
      );
    }
    await next();
  });
}

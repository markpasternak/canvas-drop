/**
 * Canvas capability model (plan 006) — the single source of truth shared by the
 * server (management projection + runtime guard) and the dashboard (Capabilities
 * tab + create flow).
 *
 * A canvas opts into **backend** capability (off by default). When backend is on,
 * four features toggle independently: `kv`, `files`, `ai`, `realtime`. Identity
 * (`me()`) has no toggle — it is on exactly when backend is on.
 *
 * The *stored* flags (the `cap_*` columns) are not the whole story: a feature is
 * only **effective** when backend is on, its own flag is on, AND the operator
 * hasn't globally disabled it (realtime via `CANVAS_DROP_REALTIME`, ai via a
 * configured provider key). {@link effectiveCapabilities} is that one rule; every
 * consumer routes through it rather than re-deriving the AND.
 */

/** The four independently-toggleable backend features (each backed by a `cap_*` column). */
export const FEATURE_CAPABILITIES = ["kv", "files", "ai", "realtime"] as const;
export type FeatureCapability = (typeof FEATURE_CAPABILITIES)[number];

/** Every gateable capability, including implicit identity (no column). */
export const CAPABILITIES = ["identity", ...FEATURE_CAPABILITIES] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The capability-bearing subset of a canvas row. The full {@link Canvas} db type
 * structurally satisfies this, so callers pass a canvas directly; tests can pass a
 * minimal literal.
 */
export interface CanvasCapabilityState {
  backendEnabled: boolean;
  capKv: boolean;
  capFiles: boolean;
  capAi: boolean;
  capRealtime: boolean;
}

/** Operator-level global switches a capability is ANDed against (from server Config). */
export interface CapabilityGlobals {
  /** `CANVAS_DROP_REALTIME === "on"` (`config.realtimeEnabled`). */
  realtimeEnabled: boolean;
  /** An AI provider is configured (`config.ai.apiKey` present). */
  aiEnabled: boolean;
}

/** Effective on/off for every capability after applying backend + flag + global. */
export type EffectiveCapabilities = Record<Capability, boolean>;

/** The stored per-feature flags, keyed by capability name (drops the `cap` prefix). */
export type StoredCapabilities = Record<FeatureCapability, boolean>;

/** Maps a feature capability to its canvas column name. */
export const FEATURE_COLUMN = {
  kv: "capKv",
  files: "capFiles",
  ai: "capAi",
  realtime: "capRealtime",
} as const satisfies Record<FeatureCapability, keyof CanvasCapabilityState>;

/** The raw stored per-feature flags (independent of backend/global state). */
export function storedCapabilities(canvas: CanvasCapabilityState): StoredCapabilities {
  return {
    kv: canvas.capKv,
    files: canvas.capFiles,
    ai: canvas.capAi,
    realtime: canvas.capRealtime,
  };
}

/**
 * The one rule. A feature is effective iff backend is on AND its flag is on AND
 * the operator global (if any) is on. Identity is effective iff backend is on.
 * KV and files have no global switch (always available once backend + flag).
 */
export function effectiveCapabilities(
  canvas: CanvasCapabilityState,
  globals: CapabilityGlobals,
): EffectiveCapabilities {
  const backend = canvas.backendEnabled;
  return {
    identity: backend,
    kv: backend && canvas.capKv,
    files: backend && canvas.capFiles,
    ai: backend && canvas.capAi && globals.aiEnabled,
    realtime: backend && canvas.capRealtime && globals.realtimeEnabled,
  };
}

/** Whether a single capability is effective for this canvas (used by the runtime guard). */
export function isCapabilityEnabled(
  canvas: CanvasCapabilityState,
  capability: Capability,
  globals: CapabilityGlobals,
): boolean {
  return effectiveCapabilities(canvas, globals)[capability];
}

import type { CanvasSettings } from "./api.js";

export type CreateAudienceChoice = "private" | "workspace" | "public";

export interface CreateAudienceState {
  choice: CreateAudienceChoice;
  listed: boolean;
  requirePassword: boolean;
  password: string;
}

export function defaultCreateAudience(): CreateAudienceState {
  return { choice: "private", listed: false, requirePassword: false, password: "" };
}

/** A destination change always returns to the narrowest audience. */
export function resetAudienceForDestination(_current: CreateAudienceState): CreateAudienceState {
  return defaultCreateAudience();
}

/** Map the compact create choice onto the existing authoritative settings contract. */
export function initialAudiencePatch(state: CreateAudienceState): CanvasSettings | null {
  switch (state.choice) {
    case "private":
      return null;
    case "workspace":
      return {
        access: "whole_org",
        discoverability: state.listed ? "listed" : "link_only",
      };
    case "public":
      return {
        access: "public_link",
        discoverability: "link_only",
        ...(state.requirePassword ? { password: state.password.trim() } : {}),
      };
  }
}

export type CreateAudienceOutcome =
  | { kind: "private" }
  | { kind: "applied" }
  | { kind: "failed"; error: unknown };

/**
 * Apply initial sharing only after publish. Failure is returned as data so the
 * create flow can preserve the published canvas + one-time key and explain that
 * access safely remained Restricted.
 */
export async function applyCreateAudience(
  canvasId: string,
  state: CreateAudienceState,
  update: (id: string, patch: CanvasSettings) => Promise<unknown>,
): Promise<CreateAudienceOutcome> {
  const patch = initialAudiencePatch(state);
  if (!patch) return { kind: "private" };
  try {
    await update(canvasId, patch);
    return { kind: "applied" };
  } catch (error) {
    return { kind: "failed", error };
  }
}

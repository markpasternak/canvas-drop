import {
  type CanvasCapabilityState,
  type CapabilityGlobals,
  effectiveCapabilities,
} from "./index.js";

export type RuntimeRole = "owner" | "editor" | "viewer";
export type RuntimeAudience = "editors" | "viewers";
/** Unknown stored audience values fail closed. Role labels are server-derived. */
export function audienceAllows(audience: string, role: RuntimeRole): boolean {
  return role === "owner" || role === "editor" || audience === "viewers";
}

export function runtimePermissions(
  canvas: CanvasCapabilityState & {
    status: string;
    aiAudience: string;
    connectionsAudience: string;
    /** Absent on rows read before the column existed; treated as `viewers`. */
    authoringAudience?: string;
  },
  role: RuntimeRole,
  globals: CapabilityGlobals,
  connectionsAvailable = false,
) {
  const active = canvas.status === "active";
  const editor = role === "owner" || role === "editor";
  const effective = effectiveCapabilities(canvas, globals);
  return {
    canEditContent: editor && (active || canvas.status === "archived"),
    canManageVersions: editor && (active || canvas.status === "archived"),
    canCreateCanvas:
      active && effective.authoring && audienceAllows(canvas.authoringAudience ?? "viewers", role),
    canReadSharedData: active && effective.kv,
    canWriteSharedData: active && effective.kv && editor,
    canSavePreferences: active && effective.kv,
    canSubmit: active && effective.kv,
    canManageSubmissions: active && effective.kv && editor,
    canUploadSharedFiles: active && effective.files && editor,
    canUploadSubmissionFiles: active && effective.files,
    canUseAi: active && effective.ai && audienceAllows(canvas.aiAudience, role),
    canUseConnections:
      active &&
      canvas.backendEnabled &&
      connectionsAvailable &&
      audienceAllows(canvas.connectionsAudience, role),
    canPublishSharedEvents: active && effective.realtime && editor,
    canPublishParticipantEvents: active && effective.realtime,
  };
}
export type RuntimePermissions = ReturnType<typeof runtimePermissions>;

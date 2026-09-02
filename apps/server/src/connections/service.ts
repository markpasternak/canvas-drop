import type { ConnectionMethod, ConnectionProfile } from "@canvas-drop/shared/db";
import { v7 as uuidv7 } from "uuid";
import type { AuditLog } from "../audit/audit-log.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import {
  CONNECTION_KEY_UNIQUE,
  type ConnectionsRepository,
} from "../db/repositories/connections.js";
import { isUniqueViolation } from "../db/unique-violation.js";
import type { SecretCipher } from "./secret-cipher.js";
import {
  type ProtectedHeaderInput,
  validateMethods,
  validateOrigin,
  validateProfileKey,
  validateProfileLabel,
  validateProtectedHeaders,
} from "./validation.js";

export type ConnectionServiceErrorCode =
  | "CONNECTION_NOT_FOUND"
  | "CANVAS_NOT_FOUND"
  | "CONNECTION_KEY_TAKEN"
  | "CONNECTION_CONFIRMATION_REQUIRED"
  | "CONNECTION_NOT_GRANTED"
  | "CONNECTION_DISABLED"
  | "CONNECTION_KEY_UNAVAILABLE";

export class ConnectionServiceError extends Error {
  constructor(
    readonly code: ConnectionServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionServiceError";
  }
}

export interface AdminConnectionView {
  id: string;
  key: string;
  label: string;
  origin: string;
  allowedMethods: ConnectionMethod[];
  protectedHeaders: Array<{ name: string; set: true }>;
  encryptionKeyAvailable: boolean;
  enabled: boolean;
  affectedCanvasCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface CanvasConnectionView {
  key: string;
  label: string;
  origin: string;
  allowedMethods: ConnectionMethod[];
  available: boolean;
  unavailableReason: "backend_off" | "disabled" | "encryption_key_unavailable" | null;
}

export interface CreateConnectionInput {
  key: string;
  label: string;
  origin: string;
  allowedMethods: string[];
  protectedHeaders?: ProtectedHeaderInput[];
  enabled?: boolean;
}

export interface UpdateConnectionInput {
  label?: string;
  origin?: string;
  allowedMethods?: string[];
  protectedHeaders?: ProtectedHeaderInput[];
  enabled?: boolean;
}

export function connectionService(deps: {
  repository: ConnectionsRepository;
  canvases: Pick<CanvasesRepository, "findById">;
  cipher: SecretCipher;
  audit: AuditLog;
}) {
  const adminView = async (profile: ConnectionProfile): Promise<AdminConnectionView> => {
    const protectedHeaders = profile.protectedHeaderNames
      .slice()
      .sort()
      .map((name) => ({ name, set: true as const }));
    return {
      id: profile.id,
      key: profile.key,
      label: profile.label,
      origin: profile.origin,
      allowedMethods: profile.allowedMethods,
      protectedHeaders,
      encryptionKeyAvailable: deps.cipher.available,
      enabled: profile.enabled,
      affectedCanvasCount: await deps.repository.countGrants(profile.id),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  };

  const managerView = (profile: ConnectionProfile, backendEnabled = true): CanvasConnectionView => {
    const keyUnavailable = !!profile.protectedHeadersEnvelope && !deps.cipher.available;
    return {
      key: profile.key,
      label: profile.label,
      origin: profile.origin,
      allowedMethods: profile.allowedMethods,
      available: backendEnabled && profile.enabled && !keyUnavailable,
      unavailableReason: keyUnavailable
        ? "encryption_key_unavailable"
        : !profile.enabled
          ? "disabled"
          : !backendEnabled
            ? "backend_off"
            : null,
    };
  };

  async function find(id: string): Promise<ConnectionProfile> {
    const profile = await deps.repository.findById(id);
    if (!profile) throw new ConnectionServiceError("CONNECTION_NOT_FOUND", "connection not found");
    return profile;
  }

  return {
    async create(actorId: string, input: CreateConnectionInput): Promise<AdminConnectionView> {
      const id = uuidv7();
      const now = Date.now();
      const headerMap = input.protectedHeaders
        ? validateProtectedHeaders(input.protectedHeaders)
        : undefined;
      const profile: ConnectionProfile = {
        id,
        key: validateProfileKey(input.key),
        label: validateProfileLabel(input.label),
        origin: validateOrigin(input.origin),
        allowedMethods: validateMethods(input.allowedMethods),
        protectedHeaderNames: headerMap ? Object.keys(headerMap).sort() : [],
        protectedHeadersEnvelope:
          headerMap && Object.keys(headerMap).length > 0
            ? deps.cipher.encrypt(id, headerMap)
            : null,
        enabled: input.enabled ?? true,
        createdBy: actorId,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await deps.repository.create(profile);
      } catch (error) {
        if (isUniqueViolation(error, CONNECTION_KEY_UNIQUE)) {
          throw new ConnectionServiceError(
            "CONNECTION_KEY_TAKEN",
            "connection key is already used",
          );
        }
        throw error;
      }
      deps.audit.recordAudit({
        actorId,
        action: "connection_profile_create",
        targetType: "connection_profile",
        targetId: id,
        meta: { key: profile.key, origin: profile.origin, methods: profile.allowedMethods },
      });
      return adminView(profile);
    },

    async listAdmin(): Promise<AdminConnectionView[]> {
      return Promise.all((await deps.repository.list()).map(adminView));
    },

    async getAdmin(id: string): Promise<AdminConnectionView> {
      return adminView(await find(id));
    },

    async update(
      actorId: string,
      id: string,
      input: UpdateConnectionInput,
    ): Promise<AdminConnectionView> {
      const current = await find(id);
      const patch: Parameters<ConnectionsRepository["update"]>[1] = { updatedAt: Date.now() };
      if (input.label !== undefined) patch.label = validateProfileLabel(input.label);
      if (input.origin !== undefined) patch.origin = validateOrigin(input.origin);
      if (input.allowedMethods !== undefined)
        patch.allowedMethods = validateMethods(input.allowedMethods);
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.protectedHeaders !== undefined) {
        const headers = validateProtectedHeaders(input.protectedHeaders);
        patch.protectedHeadersEnvelope =
          Object.keys(headers).length === 0 ? null : deps.cipher.encrypt(id, headers);
        patch.protectedHeaderNames = Object.keys(headers).sort();
      }
      const updated = await deps.repository.update(id, patch);
      if (!updated)
        throw new ConnectionServiceError("CONNECTION_NOT_FOUND", "connection not found");
      deps.audit.recordAudit({
        actorId,
        action: "connection_profile_update",
        targetType: "connection_profile",
        targetId: id,
        meta: {
          key: current.key,
          fields: Object.keys(input).filter((field) => field !== "protectedHeaders"),
          protectedHeadersChanged: input.protectedHeaders !== undefined,
        },
      });
      return adminView(updated);
    },

    async remove(actorId: string, id: string, expectedAffectedCanvasCount: number) {
      const profile = await find(id);
      const actual = await deps.repository.countGrants(id);
      if (actual !== expectedAffectedCanvasCount) {
        throw new ConnectionServiceError(
          "CONNECTION_CONFIRMATION_REQUIRED",
          `confirm deletion for ${actual} affected canvases`,
        );
      }
      const result = await deps.repository.delete(id);
      if (!result.deleted) {
        throw new ConnectionServiceError("CONNECTION_NOT_FOUND", "connection not found");
      }
      deps.audit.recordAudit({
        actorId,
        action: "connection_profile_delete",
        targetType: "connection_profile",
        targetId: id,
        meta: { key: profile.key, revokedCanvasCount: result.revokedGrants },
      });
      return result;
    },

    async attach(actorId: string, id: string, canvasId: string) {
      const [profile, canvas] = await Promise.all([find(id), deps.canvases.findById(canvasId)]);
      if (!canvas) throw new ConnectionServiceError("CANVAS_NOT_FOUND", "canvas not found");
      const attached = await deps.repository.attach({
        canvasId,
        connectionId: id,
        createdBy: actorId,
        createdAt: Date.now(),
      });
      if (attached) {
        deps.audit.recordAudit({
          actorId,
          action: "connection_grant_attach",
          targetType: "canvas",
          targetId: canvasId,
          meta: { connectionId: id, key: profile.key },
        });
      }
      return { attached, connection: managerView(profile) };
    },

    async detach(actorId: string, id: string, canvasId: string) {
      const profile = await find(id);
      const detached = await deps.repository.detach(id, canvasId);
      if (detached) {
        deps.audit.recordAudit({
          actorId,
          action: "connection_grant_detach",
          targetType: "canvas",
          targetId: canvasId,
          meta: { connectionId: id, key: profile.key },
        });
      }
      return { detached };
    },

    async listCanvases(id: string) {
      await find(id);
      return deps.repository.listCanvases(id);
    },

    async listForCanvas(canvasId: string): Promise<CanvasConnectionView[]> {
      const canvas = await deps.canvases.findById(canvasId);
      return (await deps.repository.listForCanvas(canvasId)).map(({ profile }) =>
        managerView(profile, canvas?.backendEnabled ?? false),
      );
    },

    /** Internal runtime projection. Never serialize this result: it contains credentials. */
    async resolveRuntime(canvasId: string, key: string) {
      const granted = await deps.repository.findGranted(canvasId, key);
      if (!granted) {
        throw new ConnectionServiceError("CONNECTION_NOT_GRANTED", "connection is not granted");
      }
      if (!granted.profile.enabled) {
        throw new ConnectionServiceError("CONNECTION_DISABLED", "connection is disabled");
      }
      if (granted.profile.protectedHeadersEnvelope && !deps.cipher.available) {
        throw new ConnectionServiceError(
          "CONNECTION_KEY_UNAVAILABLE",
          "connection credentials are unavailable",
        );
      }
      return {
        id: granted.profile.id,
        key: granted.profile.key,
        origin: granted.profile.origin,
        allowedMethods: granted.profile.allowedMethods,
        protectedHeaders: granted.profile.protectedHeadersEnvelope
          ? deps.cipher.decrypt(granted.profile.id, granted.profile.protectedHeadersEnvelope)
          : {},
      };
    },
  };
}

export type ConnectionService = ReturnType<typeof connectionService>;

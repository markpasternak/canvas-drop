import type { Canvas } from "@canvas-drop/shared/db";
import type { AuditLog } from "../audit/audit-log.js";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { UsersRepository } from "../db/repositories/users.js";
import { generateApiKey, hashApiKey } from "./api-key.js";
import type { ManagementRole } from "./role.js";

/**
 * Deploy-key rotation (editor-roles plan U8, KTD11): ONE function behind the management
 * `POST /:id/regenerate-key` route and the MCP `regenerate_deploy_key` tool. Editors may
 * rotate the key (KD3); rotation is made visible to the owner — the audit event records
 * the acting role, and a rotation by a NON-owner emails the owner naming the actor, since
 * it silently breaks the owner's saved credential. The plaintext is returned ONCE to the
 * caller and never stored.
 */
export interface DeployKeyActor {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  role: ManagementRole;
}

export interface DeployKeyDeps {
  canvases: Pick<CanvasesRepository, "regenerateApiKey">;
  users: Pick<UsersRepository, "findById">;
  audit: AuditLog;
  notify?: {
    notifyOwnerOfKeyRegen(input: {
      canvasSlug: string;
      canvasTitle: string;
      ownerEmail: string;
      actor: { id: string; name: string; email: string; isAdmin: boolean };
    }): Promise<unknown>;
  };
}

export async function rotateDeployKey(
  deps: DeployKeyDeps,
  canvas: Canvas,
  actor: DeployKeyActor,
): Promise<{ apiKey: string }> {
  const apiKey = generateApiKey();
  await deps.canvases.regenerateApiKey(canvas.id, hashApiKey(apiKey));
  deps.audit.recordAudit({
    action: "key_regen",
    actorId: actor.id,
    targetId: canvas.id,
    meta: { byRole: actor.role },
  });
  if (actor.role !== "owner" && deps.notify) {
    const owner = await deps.users.findById(canvas.ownerId);
    if (owner && !owner.isBlocked) {
      await deps.notify.notifyOwnerOfKeyRegen({
        canvasSlug: canvas.slug,
        canvasTitle: canvas.title,
        ownerEmail: owner.email,
        actor: { id: actor.id, name: actor.name, email: actor.email, isAdmin: actor.isAdmin },
      });
    }
  }
  return { apiKey };
}

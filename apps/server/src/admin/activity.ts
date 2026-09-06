import { z } from "zod";
import { type AuditRepository, CANVAS_AUDIT_ACTIONS } from "../db/repositories/audit.js";

export const ADMIN_ACTIVITY_ACTIONS = [
  ...CANVAS_AUDIT_ACTIONS,
  "user_block",
  "user_unblock",
  "user_promote",
  "user_demote",
  "user_grant_public",
  "user_revoke_public",
  "allowed_email_add",
  "allowed_email_remove",
  "admin_settings_update",
  "connection_profile_create",
  "connection_profile_update",
  "connection_profile_delete",
  "user_offboard",
] as const;

export const activityQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    actor: z.string().trim().max(200).optional(),
    canvasId: z.string().trim().max(100).optional(),
    action: z.enum(ADMIN_ACTIVITY_ACTIONS).optional(),
    since: z.coerce.number().int().nonnegative().optional(),
    until: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().nonnegative().max(1_000_000).default(0),
  })
  .refine((q) => q.since === undefined || q.until === undefined || q.since < q.until, {
    message: "Start must precede end",
  });

// Event-specific schemas intentionally strip every unknown field. Never spread
// stored metadata onto an admin response: old/new writers can contain secrets.
const reason = z.string().max(500).optional();
const identifier = z.string().max(200).optional();
const strings = z.array(z.string().max(200)).max(50).optional();
const safeSchemas: Record<string, z.ZodType> = {
  canvas_enable: z.object({ reason }),
  canvas_restore: z.object({ reason }),
  canvas_archive: z.object({ reason }),
  canvas_unarchive: z.object({ reason }),
  canvas_delete: z.object({ reason }),
  canvas_purge_failed: z.object({ reason }),
  canvas_disable: z.object({ reason }),
  canvas_reassign_owner: z.object({
    from: identifier,
    to: identifier,
    reason,
    previousOwnerEditor: z.boolean().optional(),
    publicLinkReverted: z.boolean().optional(),
    deployKeyRotated: z.boolean().optional(),
  }),
  canvas_transfer: z.object({
    from: identifier,
    to: identifier,
    previousOwnerEditor: z.boolean().optional(),
  }),
  canvas_feature: z.object({ featured: z.boolean().optional() }),
  pending_invitation_cancel: z.object({ email: identifier, invitationId: identifier }),
  allowed_email_add: z.object({ email: identifier }),
  allowed_email_remove: z.object({ id: identifier }),
  admin_settings_update: z.object({ keys: strings }),
  connection_profile_update: z.object({
    key: identifier,
    fields: strings,
    protectedHeadersChanged: z.boolean().optional(),
  }),
  connection_profile_create: z.object({ key: identifier, methods: strings }),
  connection_profile_delete: z.object({
    key: identifier,
    revokedCanvasCount: z.number().optional(),
  }),
  connection_grant_attach: z.object({ connectionId: identifier, key: identifier }),
  connection_grant_detach: z.object({ connectionId: identifier, key: identifier }),
  password_change: z.object({ cleared: z.boolean().optional() }),
  capabilities_update: z.object({ changed: strings }),
  share_change: z.object({ access: identifier, role: identifier }),
  rollback: z.object({ version: z.number().optional() }),
  deploy: z.object({ version: z.number().optional(), source: identifier }),
  canvas_purge: z.object({
    reason,
    versionsPurged: z.number().optional(),
    objectsDeleted: z.number().optional(),
  }),
  user_offboard: z.object({
    reason,
    reassigned: z.number().optional(),
    failed: z.number().optional(),
  }),
};

export async function listAdminActivity(
  repository: AuditRepository,
  query: z.infer<typeof activityQuerySchema>,
) {
  const result = await repository.listFiltered({
    ...query,
    actions: query.action ? [query.action] : ADMIN_ACTIVITY_ACTIONS,
  });
  return {
    total: result.total,
    limit: query.limit,
    offset: query.offset,
    events: result.items.map((row) => {
      const parsed = safeSchemas[row.action]?.safeParse(row.meta);
      return {
        id: row.id,
        actorId: row.actorId,
        actorName: row.actorName,
        actorEmail: row.actorEmail,
        action: row.action,
        targetId: row.targetId,
        targetType:
          row.targetType ??
          ((CANVAS_AUDIT_ACTIONS as readonly string[]).includes(row.action) ? "canvas" : null),
        canvasTitle: row.canvasTitle,
        canvasSlug: row.canvasSlug,
        createdAt: row.createdAt,
        details: parsed?.success
          ? (parsed.data as Record<string, string | number | boolean | string[]>)
          : {},
      };
    }),
  };
}

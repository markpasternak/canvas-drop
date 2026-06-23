import type { Invitation } from "@canvas-drop/shared/db";
import type { AllowlistEntry } from "../db/repositories/canvases.js";
import type { UsersRepository } from "../db/repositories/users.js";

/** Serialize a canvas's allowlist entries with member display identity resolved in one
 *  batched lookup. Members carry their org identity; guests carry the invited email.
 *  Shared by the management `GET /:id/allowlist` route and the MCP `list_access` tool. */
export async function resolveAllowlistEntries(
  entries: AllowlistEntry[],
  users: Pick<UsersRepository, "findByIds">,
  pending: Invitation[] = [],
) {
  const memberIds = entries
    .filter((e) => e.principalKind === "member" && e.userId)
    .map((e) => e.userId as string);
  const byId = new Map((await users.findByIds(memberIds)).map((u) => [u.id, u]));
  const active = entries.map((e) => {
    const u = e.userId ? byId.get(e.userId) : undefined;
    return {
      id: e.id,
      kind: e.principalKind,
      email: e.principalKind === "member" ? (u?.email ?? null) : e.email,
      name: u?.name ?? null,
      createdAt: e.createdAt,
    };
  });
  const activeEmails = new Set(
    active.map((e) => e.email?.trim().toLowerCase()).filter((e): e is string => !!e),
  );
  const pendingRows = pending
    .filter((inv) => !activeEmails.has(inv.email.trim().toLowerCase()))
    .map((inv) => ({
      id: `pending:${inv.id}`,
      kind: "pending" as const,
      email: inv.email,
      name: null,
      createdAt: inv.createdAt,
    }));
  return [...active, ...pendingRows];
}

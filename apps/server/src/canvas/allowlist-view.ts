import type { AllowlistEntry } from "../db/repositories/canvases.js";
import type { UsersRepository } from "../db/repositories/users.js";

/** Serialize a canvas's allowlist entries with member display identity resolved in one
 *  batched lookup. Members carry their org identity; guests carry the invited email.
 *  Shared by the management `GET /:id/allowlist` route and the MCP `list_access` tool. */
export async function resolveAllowlistEntries(
  entries: AllowlistEntry[],
  users: Pick<UsersRepository, "findByIds">,
) {
  const memberIds = entries
    .filter((e) => e.principalKind === "member" && e.userId)
    .map((e) => e.userId as string);
  const byId = new Map((await users.findByIds(memberIds)).map((u) => [u.id, u]));
  return entries.map((e) => {
    const u = e.userId ? byId.get(e.userId) : undefined;
    return {
      id: e.id,
      kind: e.principalKind,
      email: e.principalKind === "member" ? (u?.email ?? null) : e.email,
      name: u?.name ?? null,
      createdAt: e.createdAt,
    };
  });
}

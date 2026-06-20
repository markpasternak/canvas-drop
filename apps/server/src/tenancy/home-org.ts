/**
 * Resolve a new canvas's home tenant (plan 002 U4), validated against the caller's
 * SERVER-resolved membership (`orgIds`).
 *
 * Three intents, distinguished so the dashboard picker and an agent can both express them:
 *  - `undefined` (omitted) → DEFAULT: the caller's org if they belong to exactly one
 *    (members default to their Org workspace, plan U6 open-item #1), else personal.
 *  - `null` / `""` (explicit) → personal (overrides the default).
 *  - a non-empty id → that org, but only if the caller belongs to it; otherwise rejected.
 *    A client-asserted org outside the caller's membership is never trusted (§12.0 #1).
 *
 * Shared by every create surface (management create, MCP `create_canvas`, the clone path)
 * so the membership check can't drift between them.
 */
export type HomeOrgResult = { orgId: string | null } | { error: "org_forbidden" };

export function resolveHomeOrg(
  requested: string | null | undefined,
  orgIds: Set<string>,
): HomeOrgResult {
  if (requested === undefined) {
    // Default: a member of exactly one org lands in it; everyone else is personal.
    if (orgIds.size === 1) {
      const [only] = orgIds;
      return { orgId: only ?? null };
    }
    return { orgId: null };
  }
  if (requested === null || requested === "") return { orgId: null }; // explicit personal
  if (!orgIds.has(requested)) return { error: "org_forbidden" };
  return { orgId: requested };
}

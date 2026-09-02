import type { MinRole } from "../canvas/role.js";

/**
 * The minimum canvas role every MCP tool requires (editor-roles plan, KTD10). ONE
 * table, consumed by:
 *  - every canvas-scoped tool's gate (`requireRole` / `requireMutable` in server.ts read
 *    the tool's minimum here — a tool cannot be gated without an entry, and an entry's
 *    role is the only place the policy lives);
 *  - the parity tests: the registered tool inventory must equal this table's keys, and
 *    the role matrix runs every canvas-scoped tool as owner / editor / viewer / no-role.
 *
 * `any` marks a tool that is not scoped to one canvas the caller must manage (identity,
 * lists, create, teams, clone-as-template's own eligibility rule). Everything an editor
 * may do is `editor` (KD3); the owner-only acts (KD3/R7) are `owner`.
 */
export const TOOL_MIN_ROLE = {
  whoami: "any",
  list_canvases: "any",
  list_shared_canvases: "any",
  create_canvas: "any",
  clone_canvas: "any",
  create_team: "any",
  list_teams: "any",
  rename_team: "any",
  delete_team: "any",
  add_team_member: "any",
  remove_team_member: "any",
  cancel_team_invite: "any",
  list_team_members: "any",

  get_canvas: "editor",
  list_canvas_connections: "editor",
  update_canvas: "editor",
  set_capabilities: "editor",
  set_canvas_slug: "editor",
  set_canvas_preview: "editor",
  regenerate_deploy_key: "editor",
  archive_canvas: "editor",
  unarchive_canvas: "editor",
  unpublish_canvas: "editor",
  get_canvas_usage: "editor",
  list_versions: "editor",
  delete_version: "editor",
  rollback_canvas: "editor",
  get_canvas_file: "editor",
  deploy_canvas: "editor",
  begin_deploy: "editor",
  add_files: "editor",
  finalize_deploy: "editor",
  search_people: "editor",
  list_access: "editor",
  grant_access: "editor",
  invite_to_canvas: "editor",
  revoke_access: "editor",
  set_access_role: "editor",
  get_draft: "editor",
  read_draft_file: "editor",
  write_draft_file: "editor",
  delete_draft_file: "editor",
  rename_draft_file: "editor",
  publish_draft: "editor",
  restore_draft: "editor",

  delete_canvas: "owner",
  transfer_canvas: "owner",
} as const satisfies Record<string, MinRole | "any">;

export type ToolName = keyof typeof TOOL_MIN_ROLE;

/** The tools scoped to one canvas the caller must manage (their gate reads the table). */
export type CanvasToolName = {
  [K in ToolName]: (typeof TOOL_MIN_ROLE)[K] extends "any" ? never : K;
}[ToolName];

/** The minimum role for a canvas-scoped tool. */
export function minRoleOf(tool: CanvasToolName): MinRole {
  return TOOL_MIN_ROLE[tool];
}

/**
 * The inventory check (KTD10): every registered tool must have a table entry and every
 * table entry must be registered. Returned as two diffs so a failing test says which
 * side drifted. Pure, so a negative case can be asserted without a server.
 */
export function checkToolInventory(registered: readonly string[]): {
  missingFromTable: string[];
  missingFromServer: string[];
} {
  const table = new Set<string>(Object.keys(TOOL_MIN_ROLE));
  const seen = new Set(registered);
  return {
    missingFromTable: [...seen].filter((n) => !table.has(n)).sort(),
    missingFromServer: [...table].filter((n) => !seen.has(n)).sort(),
  };
}

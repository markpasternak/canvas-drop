import type {
  aiUsage,
  allowedEmails,
  auditLog,
  authoringUsage,
  canvasAllowlist,
  canvasConnections,
  canvases,
  canvasTeams,
  connectionProfiles,
  drafts,
  emailTemplates,
  files,
  guestInvites,
  guestSessions,
  invitations,
  kvEntries,
  mcpTokens,
  oauthClients,
  oauthCodes,
  orgDomains,
  orgMembers,
  orgs,
  screenshotJobs,
  sessions,
  settings,
  teamMembers,
  teams,
  uploadSessions,
  usageEvents,
  users,
  versions,
} from "./schema.pg.js";

/** JSON value stored in `jsonb` (Postgres) / TEXT-json (SQLite) columns. */
export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

/**
 * Shared row types the repository layer codes against. Derived from the
 * Postgres schema as the canonical shape; `schema.test.ts` asserts the SQLite
 * schema infers the same types, enforcing dialect parity (KTD-1).
 */
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type NewEmailTemplate = typeof emailTemplates.$inferInsert;
export type Canvas = typeof canvases.$inferSelect;
export type NewCanvas = typeof canvases.$inferInsert;
export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type OrgDomain = typeof orgDomains.$inferSelect;
export type NewOrgDomain = typeof orgDomains.$inferInsert;
export type OrgMember = typeof orgMembers.$inferSelect;
export type NewOrgMember = typeof orgMembers.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type CanvasTeam = typeof canvasTeams.$inferSelect;
export type NewCanvasTeam = typeof canvasTeams.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
/** Membership role (flat in P2 — only 'member' is written; RBAC is P4). */
export type MembershipRole = "member";
/** How an org_members row was created (P2 only materializes 'domain'). */
export type OrgMemberSource = "domain";
export type Version = typeof versions.$inferSelect;
export type NewVersion = typeof versions.$inferInsert;
export type Draft = typeof drafts.$inferSelect;
export type NewDraft = typeof drafts.$inferInsert;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type KvEntry = typeof kvEntries.$inferSelect;
export type NewKvEntry = typeof kvEntries.$inferInsert;
export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
export type AiUsage = typeof aiUsage.$inferSelect;
export type NewAiUsage = typeof aiUsage.$inferInsert;
export type AuthoringUsage = typeof authoringUsage.$inferSelect;
export type NewAuthoringUsage = typeof authoringUsage.$inferInsert;
export type GuestInvite = typeof guestInvites.$inferSelect;
export type NewGuestInvite = typeof guestInvites.$inferInsert;
export type GuestSession = typeof guestSessions.$inferSelect;
export type NewGuestSession = typeof guestSessions.$inferInsert;
export type AllowedEmail = typeof allowedEmails.$inferSelect;
export type NewAllowedEmail = typeof allowedEmails.$inferInsert;
export type OauthClient = typeof oauthClients.$inferSelect;
export type NewOauthClient = typeof oauthClients.$inferInsert;
export type OauthCode = typeof oauthCodes.$inferSelect;
export type NewOauthCode = typeof oauthCodes.$inferInsert;
export type McpToken = typeof mcpTokens.$inferSelect;
export type NewMcpToken = typeof mcpTokens.$inferInsert;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type NewUploadSession = typeof uploadSessions.$inferInsert;
export type ScreenshotJob = typeof screenshotJobs.$inferSelect;
export type NewScreenshotJob = typeof screenshotJobs.$inferInsert;
export type CanvasAllowlistEntry = typeof canvasAllowlist.$inferSelect;
export type NewCanvasAllowlistEntry = typeof canvasAllowlist.$inferInsert;
type ConnectionProfileRow = typeof connectionProfiles.$inferSelect;
type NewConnectionProfileRow = typeof connectionProfiles.$inferInsert;
export type ConnectionProfile = Omit<
  ConnectionProfileRow,
  "allowedMethods" | "protectedHeaderNames"
> & {
  allowedMethods: ConnectionMethod[];
  protectedHeaderNames: string[];
};
export type NewConnectionProfile = Omit<
  NewConnectionProfileRow,
  "allowedMethods" | "protectedHeaderNames"
> & {
  allowedMethods: ConnectionMethod[];
  protectedHeaderNames: string[];
};
export type CanvasConnection = typeof canvasConnections.$inferSelect;
export type NewCanvasConnection = typeof canvasConnections.$inferInsert;

/** Screenshot job status values (stored as text, CHECK-constrained in the schema). */
export type ScreenshotJobStatus = "pending" | "running" | "done" | "failed";

/**
 * A deployed version's / draft's file manifest: path → content metadata. The draft adds
 * per-entry WRITER metadata (editor-roles plan, KTD8): who last touched the entry and
 * when, so two editors on one file get a conflict naming the other, not a silent
 * overwrite. Published versions strip it (a version is content, not authorship).
 */
export type ManifestEntry = {
  size: number;
  hash: string;
  mime: string;
  updatedBy?: string;
  updatedAt?: number;
};
export type Manifest = Record<string, ManifestEntry>;

/** Canvas status values (stored as text, validated by zod at the boundary). */
export type CanvasStatus = "active" | "disabled" | "archived" | "deleted";

/**
 * Canvas access rung (D4 ladder). One rung per canvas, stored as text:
 *  - `private`         — Restricted: the owner, the editors and the people-and-teams
 *                        list (default; a non-owner admin is treated as any member)
 *  - `specific_people` — legacy alias of `private` (kept for API compatibility)
 *  - `team`            — legacy alias of `private` (kept for API compatibility)
 *  - `whole_org`       — any authenticated org member with the link (the former "shared")
 *  - `public_link`     — anyone with the link; revocable per account; static-only
 */
export type AccessRung = "private" | "specific_people" | "team" | "whole_org" | "public_link";
export const ACCESS_RUNGS: readonly AccessRung[] = [
  "private",
  "specific_people",
  "team",
  "whole_org",
  "public_link",
];

/**
 * The RESTRICTED family (restricted access model, plan 2026-09-02): the rungs at which
 * nobody beyond the owner, the editors, and the people-and-teams list can open the canvas.
 * `specific_people` and `team` are legacy aliases of `private` — still stored and accepted
 * on every API surface for compatibility, folded into one "Restricted" choice in the
 * dashboard, and treated identically by every access decision. The list itself ALWAYS
 * applies, at every rung; General access only ever widens beyond it.
 */
export const RESTRICTED_RUNGS: readonly AccessRung[] = ["private", "specific_people", "team"];
export function isRestrictedRung(access: string): boolean {
  return (RESTRICTED_RUNGS as readonly string[]).includes(access);
}

/**
 * Non-owner enumeration policy for access-controlled canvases.
 *  - `link_only` — access is by URL only; people who can open it do not see it in Shared.
 *  - `listed`    — people who already have access may discover it in Shared.
 *
 * This never widens URL access. It only controls the `whole_org` listing surfaces (Shared
 * for org members, and gallery eligibility); people and teams on a canvas's list always
 * see it in Shared (restricted access model).
 */
export type CanvasDiscoverability = "link_only" | "listed";
export const CANVAS_DISCOVERABILITIES: readonly CanvasDiscoverability[] = ["link_only", "listed"];

/**
 * Per-canvas preview policy (plan 004 follow-up):
 *  - `auto`   — capture a screenshot on every publish (the default)
 *  - `off`    — never capture; show the deterministic generative cover
 *  - `custom` — the owner uploaded a preview image; a publish never overwrites it
 */
export type PreviewMode = "auto" | "off" | "custom";

/** A canvas-allowlist principal kind (members reference a user row; guests an email). */
export type AllowlistPrincipalKind = "member" | "guest";
/**
 * Role carried by a people-list entry or a team grant (editor-roles plan, KD1/KD3):
 *  - `viewer` — read access per the access ladder (the default; every pre-existing row)
 *  - `editor` — owner-equivalent except the owner-only acts; org members and teams only
 * Stored as unchecked text (`canvas_allowlist.role`, `canvas_teams.role`) and
 * validated at the zod boundary.
 */
export type AccessRole = "viewer" | "editor";
export const ACCESS_ROLES: readonly AccessRole[] = ["viewer", "editor"];
/**
 * Version source values (`editor` = published from the in-browser draft, M5;
 * `upload` = published via the two-channel staging→finalize flow, plan 003).
 * `VersionSource` is the alias matching the `versions.source` column name.
 */
export type DeploySource = "folder" | "zip" | "paste" | "api" | "editor" | "upload";
export type VersionSource = DeploySource;

/** Version readiness (`versions.status`, CHECK-constrained in the schema). */
export type VersionStatus = "pending" | "ready";

/** MCP token kind (`mcp_tokens.kind`). */
export type McpTokenKind = "access" | "refresh";

/** Guest-invite lifecycle state (`guest_invites.state`, CHECK-constrained). */
export type GuestInviteState = "pending" | "active" | "revoked";

/** Standard methods an admin may allow on a connection profile. */
export type ConnectionMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Usage-event types (`usage_events.type`). */
export type UsageEventType =
  | "kv_op"
  | "file_op"
  | "view"
  | "deploy"
  | "rt_connect"
  | "connection_op";

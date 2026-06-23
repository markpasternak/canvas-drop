import { type AccessRung, type Canvas, pgSchema, sqliteSchema } from "@canvas-drop/shared/db";
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { DbClient } from "../factory.js";

/** Window for the "new in the last N days" growth stats (§6.10.6). */
const RECENT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A canvas status the admin list can filter on (admin sees every status). */
export type AdminCanvasStatus = "active" | "disabled" | "archived" | "deleted";

/** Sort axes for the admin all-canvases list (member-parity, plan 006). */
export type AdminCanvasSort = "recent" | "created" | "title";
export type AdminCanvasExpiryFilter = "none" | "active" | "expired";
export type AdminCanvasContextFilter = "personal" | "org" | "team";

export interface AdminCanvasExposure {
  /** Direct specific-people rows, excluding pending grants. */
  specificPeopleCount: number;
  /** Team grants attached to this canvas. */
  teamCount: number;
  /** Unconsumed canvas/team invitations that can affect this canvas. */
  pendingInviteCount: number;
  /** Signed-in no-org direct members, email rows, and pending grants. */
  externalPeopleCount: number;
}

export interface ListAllCanvasesQuery {
  /** Narrow to one status; default returns all non-deleted canvases. */
  status?: AdminCanvasStatus;
  /** Substring match over title / slug / owner email (case-insensitive). */
  q?: string;
  /** Drill-down: restrict to a single owner by user id ("see what they have"). */
  owner?: string;
  /** Drill-down: restrict to canvases owned by, directly shared with, or pending for this email. */
  person?: string;
  /** Governance filter: narrow to one access rung (e.g. find every `public_link`). */
  access?: AccessRung;
  /** Effective public-link filter (access rung + owner/global capability). */
  publicLink?: boolean;
  publicLinksEnabled?: boolean;
  /** Stored password gate filter. */
  password?: boolean;
  /** Share-window filter over sharedExpiresAt. */
  expiry?: AdminCanvasExpiryFilter;
  /** Home/access context filter: personal, org, or team-rung. */
  context?: AdminCanvasContextFilter;
  /** Exposure filter: canvases involving external people. */
  external?: boolean;
  /** Exposure filter: canvases with unconsumed pending grants. */
  pending?: boolean;
  /** Gallery filter: only canvases offered as clone-able templates (galleryTemplatable). */
  templatable?: boolean;
  /** Gallery filter: only canvases listed in the public gallery (galleryListed). */
  listed?: boolean;
  /** Sort axis; defaults to `recent` (last activity). */
  sort?: AdminCanvasSort;
  limit: number;
  offset: number;
}

/** Sort axes for the admin users list (plan 006). */
export type AdminUserSort = "active" | "created" | "name" | "canvases";

export interface ListUsersQuery {
  /** Substring match over name / email (case-insensitive). */
  q?: string;
  sort?: AdminUserSort;
  limit: number;
  offset: number;
}

export type AdminPersonKind = "org_member" | "external" | "pending";
export type AdminPublicCapabilityFilter = "allowed" | "revoked";

export interface ListPeopleQuery extends ListUsersQuery {
  kind?: AdminPersonKind;
  pending?: boolean;
  blocked?: boolean;
  admin?: boolean;
  permit?: boolean;
  publicCapability?: AdminPublicCapabilityFilter;
}

export interface AdminPendingGrant {
  id: string;
  targetType: "canvas" | "team";
  targetId: string;
  createdAt: number;
  invitedBy: string;
}

export interface AdminPersonRow {
  /** Canonical merge key: lowercased email. */
  email: string;
  kind: AdminPersonKind;
  orgMember: boolean;
  userId: string | null;
  name: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  isBlocked: boolean;
  canPublishPublic: boolean | null;
  createdAt: number | null;
  lastSeenAt: number | null;
  canvasCount: number;
  permitId: string | null;
  permitCreatedAt: number | null;
  permitCreatedBy: string | null;
  pendingCount: number;
  pendingCanvasCount: number;
  pendingTeamCount: number;
  pendingGrants: AdminPendingGrant[];
}

/**
 * One row of the admin user-management table (plan 006). Identity + governance
 * facts only — `canvasCount` is an OBJECT fact (how much this person owns), never
 * a behavioral one. No view history, no sessions, no per-user activity (the
 * "governance without surveillance" line). `lastSeenAt` is a deliberate
 * admin-hygiene exception (spotting dormant admins).
 */
export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  isBlocked: boolean;
  /** Per-user publish-public capability (default on; admin-revocable). */
  canPublishPublic: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** Non-deleted canvases this user owns (object fact). */
  canvasCount: number;
}

/** Platform overview aggregates (§6.10.6 — AI spend deferred to M9). */
export interface PlatformStats {
  canvasCountByStatus: Record<string, number>;
  /** Active canvases published as a static public link (access='public_link') — the
   *  governance count of how much is exposed beyond the org (2026-06-19). Scoped to
   *  `active` only, like the other "live" overview signals. */
  publicLinkCount: number;
  userCount: number;
  /** Total stored file bytes across every canvas (deployed-version bytes show per-canvas). */
  totalFileBytes: number;
  /** Total recorded primitive ops across the platform (KV/file/etc), all time. */
  totalOps: number;
  /** Total recorded canvas page views across the platform, all time. */
  totalViews: number;
  /** Distinct org members who have viewed any canvas (engagement reach). */
  uniqueViewers: number;
  /** Total deploys across the platform (one per published version), all time. */
  totalDeploys: number;
  /** Canvases created in the last {@link RECENT_WINDOW_DAYS} days (growth signal). */
  newCanvases: number;
  /** Users first seen in the last {@link RECENT_WINDOW_DAYS} days (growth signal). */
  newUsers: number;
  /** Window (days) the `new*` counts span — surfaced so the UI labels itself. */
  recentWindowDays: number;
  /** Oldest soft-deleted canvas's `deletedAt` (purge backlog age); null if none pending. */
  oldestDeletedAt: number | null;
  /** Most-active canvases by recorded primitive ops, newest usage first. */
  topCanvases: Array<{ canvasId: string; ops: number }>;
}

/**
 * Admin cross-owner read repository (§6.10, M7). The ONLY repository that reads
 * canvases across every owner — every other read path is owner-scoped (§12.0 #3).
 * Reachable only behind `requireAdmin` (server-resolved `isAdmin`). Status
 * transitions (disable/enable/restore) live on `canvasesRepository` next to
 * archive/unarchive (same guarded-transition pattern). Dual-dialect seam typed
 * `any` (KTD-1); aggregates `coalesce`+`Number()` for the pg-string / NULL-on-empty
 * trap.
 */
export function adminRepository(client: DbClient) {
  // biome-ignore lint/suspicious/noExplicitAny: dual-dialect db seam
  const db = client.db as any;
  const sqlite = client.dialect === "sqlite";
  const canvasesT = sqlite ? sqliteSchema.canvases : pgSchema.canvases;
  const usersT = sqlite ? sqliteSchema.users : pgSchema.users;
  const allowedEmailsT = sqlite ? sqliteSchema.allowedEmails : pgSchema.allowedEmails;
  const invitationsT = sqlite ? sqliteSchema.invitations : pgSchema.invitations;
  const orgMembersT = sqlite ? sqliteSchema.orgMembers : pgSchema.orgMembers;
  const canvasAllowlistT = sqlite ? sqliteSchema.canvasAllowlist : pgSchema.canvasAllowlist;
  const teamMembersT = sqlite ? sqliteSchema.teamMembers : pgSchema.teamMembers;
  const canvasTeamsT = sqlite ? sqliteSchema.canvasTeams : pgSchema.canvasTeams;
  const filesT = sqlite ? sqliteSchema.files : pgSchema.files;
  const usageT = sqlite ? sqliteSchema.usageEvents : pgSchema.usageEvents;
  const versionsT = sqlite ? sqliteSchema.versions : pgSchema.versions;

  const blankExposure = (): AdminCanvasExposure => ({
    specificPeopleCount: 0,
    teamCount: 0,
    pendingInviteCount: 0,
    externalPeopleCount: 0,
  });

  async function exposureByCanvasIds(ids: string[]): Promise<Map<string, AdminCanvasExposure>> {
    const map = new Map(ids.map((id) => [id, blankExposure()]));
    if (ids.length === 0) return map;

    const allowRows = (await db
      .select({
        canvasId: canvasAllowlistT.canvasId,
        userId: canvasAllowlistT.userId,
        email: canvasAllowlistT.email,
      })
      .from(canvasAllowlistT)
      .where(inArray(canvasAllowlistT.canvasId, ids))) as Array<{
      canvasId: string;
      userId: string | null;
      email: string | null;
    }>;
    const allowUserIds = [
      ...new Set(allowRows.map((r) => r.userId).filter((id): id is string => id !== null)),
    ];
    const orgRows =
      allowUserIds.length > 0
        ? ((await db
            .select({ userId: orgMembersT.userId })
            .from(orgMembersT)
            .where(inArray(orgMembersT.userId, allowUserIds))) as Array<{ userId: string }>)
        : [];
    const orgUserIds = new Set(orgRows.map((r) => r.userId));

    for (const row of allowRows) {
      const exposure = map.get(row.canvasId);
      if (!exposure) continue;
      exposure.specificPeopleCount += 1;
      if (row.email !== null || (row.userId !== null && !orgUserIds.has(row.userId))) {
        exposure.externalPeopleCount += 1;
      }
    }

    const teamRows = (await db
      .select({ canvasId: canvasTeamsT.canvasId, teamId: canvasTeamsT.teamId })
      .from(canvasTeamsT)
      .where(inArray(canvasTeamsT.canvasId, ids))) as Array<{ canvasId: string; teamId: string }>;
    const canvasIdsByTeam = new Map<string, string[]>();
    for (const row of teamRows) {
      const exposure = map.get(row.canvasId);
      if (!exposure) continue;
      exposure.teamCount += 1;
      canvasIdsByTeam.set(row.teamId, [...(canvasIdsByTeam.get(row.teamId) ?? []), row.canvasId]);
    }

    const pendingCanvasRows = (await db
      .select({ canvasId: invitationsT.targetId })
      .from(invitationsT)
      .where(
        and(
          eq(invitationsT.targetType, "canvas"),
          inArray(invitationsT.targetId, ids),
          isNull(invitationsT.consumedAt),
        ),
      )) as Array<{ canvasId: string }>;
    for (const row of pendingCanvasRows) {
      const exposure = map.get(row.canvasId);
      if (!exposure) continue;
      exposure.pendingInviteCount += 1;
      exposure.externalPeopleCount += 1;
    }

    const teamIds = [...canvasIdsByTeam.keys()];
    if (teamIds.length > 0) {
      const pendingTeamRows = (await db
        .select({ teamId: invitationsT.targetId })
        .from(invitationsT)
        .where(
          and(
            eq(invitationsT.targetType, "team"),
            inArray(invitationsT.targetId, teamIds),
            isNull(invitationsT.consumedAt),
          ),
        )) as Array<{ teamId: string }>;
      for (const row of pendingTeamRows) {
        for (const canvasId of canvasIdsByTeam.get(row.teamId) ?? []) {
          const exposure = map.get(canvasId);
          if (!exposure) continue;
          exposure.pendingInviteCount += 1;
          exposure.externalPeopleCount += 1;
        }
      }
    }

    return map;
  }

  async function allCanvasIdsByExposure(): Promise<{
    rows: Array<{ id: string }>;
    exposure: Map<string, AdminCanvasExposure>;
  }> {
    const rows = (await db
      .select({ id: canvasesT.id })
      .from(canvasesT)
      .where(ne(canvasesT.status, "deleted"))) as Array<{ id: string }>;
    const exposure = await exposureByCanvasIds(rows.map((r) => r.id));
    return { rows, exposure };
  }

  return {
    /**
     * Cross-owner canvas list with member-parity filter/search/sort + offset
     * pagination (plan 006 — replaces the prior keyset list so the admin table can
     * sort on arbitrary axes, which a single-column keyset cursor can't). The only
     * non-owner-scoped canvas read in the app (§12.0 #3); reachable solely behind
     * `requireAdmin`. Default excludes soft-deleted (the deleted-restore view passes
     * `status:"deleted"` explicitly). Joins `users` so the search can match an owner
     * email — an OBJECT fact (the canvas's owner), not audience behavior. Two-query
     * count posture at single-org scale, like the gallery / Your-canvases lists.
     */
    async listAllCanvasesFiltered(
      q: ListAllCanvasesQuery,
    ): Promise<{ items: Canvas[]; total: number }> {
      const filters: Array<SQL | undefined> = [];
      if (q.status) filters.push(eq(canvasesT.status, q.status));
      else filters.push(ne(canvasesT.status, "deleted"));
      if (q.owner) filters.push(eq(canvasesT.ownerId, q.owner));
      if (q.publicLink) {
        filters.push(eq(canvasesT.access, "public_link"));
        filters.push(eq(usersT.canPublishPublic, true));
        if (q.publicLinksEnabled === false) filters.push(sql`1 = 0`);
      }
      if (q.password) filters.push(isNotNull(canvasesT.passwordHash));
      if (q.expiry === "none") filters.push(isNull(canvasesT.sharedExpiresAt));
      else if (q.expiry === "active") {
        filters.push(sql`${canvasesT.sharedExpiresAt} is not null`);
        filters.push(sql`${canvasesT.sharedExpiresAt} > ${Date.now()}`);
      } else if (q.expiry === "expired") {
        filters.push(sql`${canvasesT.sharedExpiresAt} is not null`);
        filters.push(sql`${canvasesT.sharedExpiresAt} <= ${Date.now()}`);
      }
      if (q.context === "personal") {
        filters.push(and(isNull(canvasesT.orgId), ne(canvasesT.access, "team")));
      } else if (q.context === "org") {
        filters.push(and(isNotNull(canvasesT.orgId), ne(canvasesT.access, "team")));
      } else if (q.context === "team") filters.push(eq(canvasesT.access, "team"));
      if (q.external || q.pending) {
        const { rows, exposure } = await allCanvasIdsByExposure();
        const matchingIds = new Set(
          rows
            .map((r) => r.id)
            .filter((id) => {
              const e = exposure.get(id) ?? blankExposure();
              return (
                (!q.external || e.externalPeopleCount > 0) &&
                (!q.pending || e.pendingInviteCount > 0)
              );
            }),
        );
        filters.push(matchingIds.size > 0 ? inArray(canvasesT.id, [...matchingIds]) : sql`1 = 0`);
      }
      const person = q.person?.trim().toLowerCase();
      if (person) {
        const personUsers = (await db
          .select({ id: usersT.id })
          .from(usersT)
          .where(sql`lower(${usersT.email}) = ${person}`)) as Array<{ id: string }>;
        const personUserIds = personUsers.map((u) => u.id);
        const personCanvasIds = new Set<string>();

        const guestAllowlistRows = (await db
          .select({ canvasId: canvasAllowlistT.canvasId })
          .from(canvasAllowlistT)
          .where(eq(canvasAllowlistT.email, person))) as Array<{ canvasId: string }>;
        for (const row of guestAllowlistRows) personCanvasIds.add(row.canvasId);

        let teamIds: string[] = [];
        if (personUserIds.length > 0) {
          const memberAllowlistRows = (await db
            .select({ canvasId: canvasAllowlistT.canvasId })
            .from(canvasAllowlistT)
            .where(inArray(canvasAllowlistT.userId, personUserIds))) as Array<{
            canvasId: string;
          }>;
          for (const row of memberAllowlistRows) personCanvasIds.add(row.canvasId);

          const memberTeamRows = (await db
            .select({ teamId: teamMembersT.teamId })
            .from(teamMembersT)
            .where(inArray(teamMembersT.userId, personUserIds))) as Array<{ teamId: string }>;
          teamIds = memberTeamRows.map((r) => r.teamId);
        }

        const pendingCanvasRows = (await db
          .select({ canvasId: invitationsT.targetId })
          .from(invitationsT)
          .where(
            and(
              eq(invitationsT.email, person),
              eq(invitationsT.targetType, "canvas"),
              isNull(invitationsT.consumedAt),
            ),
          )) as Array<{ canvasId: string }>;
        for (const row of pendingCanvasRows) personCanvasIds.add(row.canvasId);

        const pendingTeamRows = (await db
          .select({ teamId: invitationsT.targetId })
          .from(invitationsT)
          .where(
            and(
              eq(invitationsT.email, person),
              eq(invitationsT.targetType, "team"),
              isNull(invitationsT.consumedAt),
            ),
          )) as Array<{ teamId: string }>;
        teamIds.push(...pendingTeamRows.map((r) => r.teamId));
        teamIds = [...new Set(teamIds)];

        if (teamIds.length > 0) {
          const teamCanvasRows = (await db
            .select({ canvasId: canvasTeamsT.canvasId })
            .from(canvasTeamsT)
            .where(inArray(canvasTeamsT.teamId, teamIds))) as Array<{ canvasId: string }>;
          for (const row of teamCanvasRows) personCanvasIds.add(row.canvasId);
        }

        const personFilters: SQL[] = [];
        if (personUserIds.length > 0) {
          personFilters.push(inArray(canvasesT.ownerId, personUserIds) as SQL);
        }
        if (personCanvasIds.size > 0) {
          personFilters.push(inArray(canvasesT.id, [...personCanvasIds]) as SQL);
        }
        filters.push(personFilters.length > 0 ? (or(...personFilters) as SQL) : sql`1 = 0`);
      }
      if (q.access) filters.push(eq(canvasesT.access, q.access));
      // Gallery facets — each maps to one boolean canvas column. `templatable`
      // implies listed at the data level, but they filter independently here so an
      // admin can isolate either set.
      if (q.templatable) filters.push(eq(canvasesT.galleryTemplatable, true));
      if (q.listed) filters.push(eq(canvasesT.galleryListed, true));

      const search = q.q?.trim().toLowerCase();
      if (search) {
        // Portable, metacharacter-escaped LIKE over the admin-facing identifiers:
        // title, slug, and the owner's email (the canvas's owner — object fact).
        const pattern = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        filters.push(
          or(
            sql`lower(${canvasesT.title}) like ${pattern} escape '\\'`,
            sql`lower(${canvasesT.slug}) like ${pattern} escape '\\'`,
            sql`lower(${usersT.email}) like ${pattern} escape '\\'`,
          ),
        );
      }
      const where = and(...filters);

      // Default is most-recent-activity (updatedAt); `created` and `title` mirror the
      // member list's axes. Every axis keeps an `id` tiebreak (uuidv7 monotonic) so
      // pages don't shuffle within an equal sort key.
      const orderBy =
        q.sort === "created"
          ? [desc(canvasesT.createdAt), desc(canvasesT.id)]
          : q.sort === "title"
            ? [sql`lower(${canvasesT.title}) asc`, desc(canvasesT.id)]
            : [desc(canvasesT.updatedAt), desc(canvasesT.id)];

      const rows = (await db
        .select({ canvas: canvasesT })
        .from(canvasesT)
        .leftJoin(usersT, eq(canvasesT.ownerId, usersT.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(q.limit)
        .offset(q.offset)) as Array<{ canvas: Canvas }>;

      // Each canvas has exactly one owner, so the left join never multiplies rows —
      // count(*) over the same join is the exact total.
      const totalRows = (await db
        .select({ value: sql<number>`count(*)` })
        .from(canvasesT)
        .leftJoin(usersT, eq(canvasesT.ownerId, usersT.id))
        .where(where)) as Array<{ value: number }>;

      return { items: rows.map((r) => r.canvas), total: Number(totalRows[0]?.value ?? 0) };
    },

    /**
     * Governance-first People directory keyed by canonical email (plan 2026-06-23 U6).
     * Merges signed-in users, individual sign-in permits, and unconsumed pending grants
     * so an admin sees one row per person/email instead of separate partial tables.
     * Built in memory from bounded governance tables at single-instance scale; no
     * behavioral data is read beyond owned-canvas counts and last-seen hygiene.
     */
    async listPeople(q: ListPeopleQuery): Promise<{ items: AdminPersonRow[]; total: number }> {
      const countExpr = sql<number>`count(${canvasesT.id})`;
      const userRows = (await db
        .select({
          id: usersT.id,
          email: usersT.email,
          name: usersT.name,
          avatarUrl: usersT.avatarUrl,
          isAdmin: usersT.isAdmin,
          isBlocked: usersT.isBlocked,
          canPublishPublic: usersT.canPublishPublic,
          createdAt: usersT.createdAt,
          lastSeenAt: usersT.lastSeenAt,
          canvasCount: countExpr,
        })
        .from(usersT)
        .leftJoin(canvasesT, and(eq(canvasesT.ownerId, usersT.id), ne(canvasesT.status, "deleted")))
        .groupBy(usersT.id)) as Array<AdminUserRow>;

      const orgRows = (await db
        .select({ userId: orgMembersT.userId })
        .from(orgMembersT)
        .groupBy(orgMembersT.userId)) as Array<{ userId: string }>;
      const orgUserIds = new Set(orgRows.map((r) => r.userId));

      const permitRows = (await db.select().from(allowedEmailsT)) as Array<{
        id: string;
        email: string;
        createdBy: string | null;
        createdAt: number;
      }>;

      const invitationRows = (await db
        .select({
          id: invitationsT.id,
          email: invitationsT.email,
          targetType: invitationsT.targetType,
          targetId: invitationsT.targetId,
          createdAt: invitationsT.createdAt,
          invitedBy: invitationsT.invitedBy,
        })
        .from(invitationsT)
        .where(isNull(invitationsT.consumedAt))) as Array<{
        id: string;
        email: string;
        targetType: "canvas" | "team";
        targetId: string;
        createdAt: number;
        invitedBy: string;
      }>;

      const byEmail = new Map<string, AdminPersonRow>();
      const ensure = (email: string): AdminPersonRow => {
        const key = email.trim().toLowerCase();
        const existing = byEmail.get(key);
        if (existing) return existing;
        const row: AdminPersonRow = {
          email: key,
          kind: "external",
          orgMember: false,
          userId: null,
          name: null,
          avatarUrl: null,
          isAdmin: false,
          isBlocked: false,
          canPublishPublic: null,
          createdAt: null,
          lastSeenAt: null,
          canvasCount: 0,
          permitId: null,
          permitCreatedAt: null,
          permitCreatedBy: null,
          pendingCount: 0,
          pendingCanvasCount: 0,
          pendingTeamCount: 0,
          pendingGrants: [],
        };
        byEmail.set(key, row);
        return row;
      };

      for (const u of userRows) {
        const row = ensure(u.email);
        row.userId = u.id;
        row.name = u.name;
        row.avatarUrl = u.avatarUrl;
        row.isAdmin = Boolean(u.isAdmin);
        row.isBlocked = Boolean(u.isBlocked);
        row.canPublishPublic = Boolean(u.canPublishPublic);
        row.createdAt = Number(u.createdAt);
        row.lastSeenAt = u.lastSeenAt === null ? null : Number(u.lastSeenAt);
        row.canvasCount = Number(u.canvasCount);
        row.orgMember = orgUserIds.has(u.id);
      }

      for (const permit of permitRows) {
        const row = ensure(permit.email);
        row.permitId = permit.id;
        row.permitCreatedAt = Number(permit.createdAt);
        row.permitCreatedBy = permit.createdBy;
      }

      for (const inv of invitationRows) {
        const row = ensure(inv.email);
        row.pendingGrants.push({
          id: inv.id,
          targetType: inv.targetType,
          targetId: inv.targetId,
          createdAt: Number(inv.createdAt),
          invitedBy: inv.invitedBy,
        });
      }

      let rows = [...byEmail.values()].map((row) => {
        row.pendingGrants.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        row.pendingCount = row.pendingGrants.length;
        row.pendingCanvasCount = row.pendingGrants.filter((g) => g.targetType === "canvas").length;
        row.pendingTeamCount = row.pendingGrants.filter((g) => g.targetType === "team").length;
        row.kind = row.orgMember
          ? "org_member"
          : row.userId === null && row.pendingCount > 0
            ? "pending"
            : "external";
        return row;
      });

      const search = q.q?.trim().toLowerCase();
      if (search) {
        rows = rows.filter(
          (row) =>
            row.email.includes(search) || (row.name?.toLowerCase().includes(search) ?? false),
        );
      }
      if (q.kind) rows = rows.filter((row) => row.kind === q.kind);
      if (q.pending) rows = rows.filter((row) => row.pendingCount > 0);
      if (q.blocked) rows = rows.filter((row) => row.isBlocked);
      if (q.admin) rows = rows.filter((row) => row.isAdmin);
      if (q.permit) rows = rows.filter((row) => row.permitId !== null);
      if (q.publicCapability === "allowed") {
        rows = rows.filter((row) => row.userId !== null && row.canPublishPublic === true);
      } else if (q.publicCapability === "revoked") {
        rows = rows.filter((row) => row.userId !== null && row.canPublishPublic === false);
      }

      rows.sort((a, b) => {
        if (q.sort === "created") {
          return (
            Number(b.createdAt ?? b.permitCreatedAt ?? b.pendingGrants[0]?.createdAt ?? 0) -
              Number(a.createdAt ?? a.permitCreatedAt ?? a.pendingGrants[0]?.createdAt ?? 0) ||
            b.email.localeCompare(a.email)
          );
        }
        if (q.sort === "name") {
          return (
            (a.name ?? a.email).localeCompare(b.name ?? b.email) || a.email.localeCompare(b.email)
          );
        }
        if (q.sort === "canvases") {
          return b.canvasCount - a.canvasCount || a.email.localeCompare(b.email);
        }
        return (
          Number(b.lastSeenAt ?? 0) - Number(a.lastSeenAt ?? 0) ||
          Number(b.createdAt ?? b.permitCreatedAt ?? b.pendingGrants[0]?.createdAt ?? 0) -
            Number(a.createdAt ?? a.permitCreatedAt ?? a.pendingGrants[0]?.createdAt ?? 0) ||
          a.email.localeCompare(b.email)
        );
      });

      const total = rows.length;
      return { items: rows.slice(q.offset, q.offset + q.limit), total };
    },

    /**
     * Cross-owner user-management list (plan 006): identity + governance facts with
     * per-user owned-canvas counts, filter/search/sort + offset pagination. The
     * count LEFT JOINs canvases (excluding soft-deleted tombstones) so a user with
     * zero canvases still appears with count 0. `group by users.id` is valid on both
     * dialects (Postgres functional-dependency on the PK; SQLite is lenient). NO
     * behavioral data is read here — only object/identity facts (governance without
     * surveillance).
     */
    async listUsers(q: ListUsersQuery): Promise<{ items: AdminUserRow[]; total: number }> {
      const filters: Array<SQL | undefined> = [];
      const search = q.q?.trim().toLowerCase();
      if (search) {
        const pattern = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        filters.push(
          or(
            sql`lower(${usersT.name}) like ${pattern} escape '\\'`,
            sql`lower(${usersT.email}) like ${pattern} escape '\\'`,
          ),
        );
      }
      const where = filters.length > 0 ? and(...filters) : undefined;

      const countExpr = sql<number>`count(${canvasesT.id})`;
      const orderBy =
        q.sort === "created"
          ? [desc(usersT.createdAt), desc(usersT.id)]
          : q.sort === "name"
            ? [sql`lower(${usersT.name}) asc`, desc(usersT.id)]
            : q.sort === "canvases"
              ? [sql`${countExpr} desc`, desc(usersT.id)]
              : // "active" (default): most-recently-seen first; never-seen rows last.
                [sql`${usersT.lastSeenAt} desc nulls last`, desc(usersT.id)];

      const rows = (await db
        .select({
          id: usersT.id,
          email: usersT.email,
          name: usersT.name,
          avatarUrl: usersT.avatarUrl,
          isAdmin: usersT.isAdmin,
          isBlocked: usersT.isBlocked,
          canPublishPublic: usersT.canPublishPublic,
          createdAt: usersT.createdAt,
          lastSeenAt: usersT.lastSeenAt,
          canvasCount: countExpr,
        })
        .from(usersT)
        .leftJoin(canvasesT, and(eq(canvasesT.ownerId, usersT.id), ne(canvasesT.status, "deleted")))
        .where(where)
        .groupBy(usersT.id)
        .orderBy(...orderBy)
        .limit(q.limit)
        .offset(q.offset)) as Array<AdminUserRow>;

      const totalRows = (await db
        .select({ value: sql<number>`count(*)` })
        .from(usersT)
        .where(where)) as Array<{ value: number }>;

      return {
        items: rows.map((r) => ({
          id: r.id,
          email: r.email,
          name: r.name,
          avatarUrl: r.avatarUrl,
          isAdmin: Boolean(r.isAdmin),
          isBlocked: Boolean(r.isBlocked),
          canPublishPublic: Boolean(r.canPublishPublic),
          createdAt: Number(r.createdAt),
          lastSeenAt: r.lastSeenAt === null ? null : Number(r.lastSeenAt),
          canvasCount: Number(r.canvasCount),
        })),
        total: Number(totalRows[0]?.value ?? 0),
      };
    },

    /**
     * Platform overview aggregates for the admin dashboard (§6.10.6). `now` is
     * injectable so the "new in the last N days" window is deterministic in tests.
     */
    async platformStats(topLimit: number, now: number = Date.now()): Promise<PlatformStats> {
      const recentCutoff = now - RECENT_WINDOW_DAYS * DAY_MS;
      const [
        statusRows,
        publicLinkRows,
        userRows,
        byteRows,
        opsRows,
        newCanvasRows,
        newUserRows,
        deletedRows,
        topRows,
        viewRows,
        deployRows,
      ] = await Promise.all([
        db
          .select({ status: canvasesT.status, count: sql<number>`count(*)` })
          .from(canvasesT)
          .groupBy(canvasesT.status),
        // Active public-link canvases (governance: what's exposed beyond the org).
        // Scoped to `active` so it aligns with the live-canvas overview signals.
        db
          .select({ count: sql<number>`count(*)` })
          .from(canvasesT)
          .where(and(eq(canvasesT.status, "active"), eq(canvasesT.access, "public_link"))),
        db.select({ count: sql<number>`count(*)` }).from(usersT),
        db.select({ total: sql<number>`coalesce(sum(${filesT.sizeBytes}), 0)` }).from(filesT),
        db.select({ count: sql<number>`count(*)` }).from(usageT),
        db
          .select({ count: sql<number>`count(*)` })
          .from(canvasesT)
          .where(gte(canvasesT.createdAt, recentCutoff)),
        db
          .select({ count: sql<number>`count(*)` })
          .from(usersT)
          .where(gte(usersT.createdAt, recentCutoff)),
        db
          .select({ oldest: sql<number | null>`min(${canvasesT.deletedAt})` })
          .from(canvasesT)
          .where(eq(canvasesT.status, "deleted")),
        db
          .select({ canvasId: usageT.canvasId, ops: sql<number>`count(*)` })
          .from(usageT)
          .groupBy(usageT.canvasId)
          .orderBy(desc(sql`count(*)`))
          .limit(topLimit),
        db
          .select({
            total: sql<number>`count(*)`,
            unique: sql<number>`count(distinct ${usageT.userId})`,
          })
          .from(usageT)
          .where(eq(usageT.type, "view")),
        // One *ready* version row per deploy. Pending/failed builds never went
        // live, so they aren't deploys and must not inflate the count.
        db
          .select({ count: sql<number>`count(*)` })
          .from(versionsT)
          .where(eq(versionsT.status, "ready")),
      ]);
      const canvasCountByStatus: Record<string, number> = {};
      for (const r of statusRows as Array<{ status: string; count: number }>) {
        canvasCountByStatus[r.status] = Number(r.count);
      }
      const oldest = (deletedRows as Array<{ oldest: number | null }>)[0]?.oldest ?? null;
      return {
        canvasCountByStatus,
        publicLinkCount: Number((publicLinkRows as Array<{ count: number }>)[0]?.count ?? 0),
        userCount: Number((userRows as Array<{ count: number }>)[0]?.count ?? 0),
        totalFileBytes: Number((byteRows as Array<{ total: number }>)[0]?.total ?? 0),
        totalOps: Number((opsRows as Array<{ count: number }>)[0]?.count ?? 0),
        totalViews: Number((viewRows as Array<{ total: number }>)[0]?.total ?? 0),
        uniqueViewers: Number((viewRows as Array<{ unique: number }>)[0]?.unique ?? 0),
        totalDeploys: Number((deployRows as Array<{ count: number }>)[0]?.count ?? 0),
        newCanvases: Number((newCanvasRows as Array<{ count: number }>)[0]?.count ?? 0),
        newUsers: Number((newUserRows as Array<{ count: number }>)[0]?.count ?? 0),
        recentWindowDays: RECENT_WINDOW_DAYS,
        oldestDeletedAt: oldest === null ? null : Number(oldest),
        topCanvases: (topRows as Array<{ canvasId: string; ops: number }>).map((r) => ({
          canvasId: r.canvasId,
          ops: Number(r.ops),
        })),
      };
    },

    /** Batched exposure summaries for the admin list's governance columns (no N+1). */
    async exposureByCanvas(
      canvasIds: readonly string[],
    ): Promise<Map<string, AdminCanvasExposure>> {
      return exposureByCanvasIds([...canvasIds]);
    },

    /** Batched per-canvas op counts for the admin list's "usage" column (no N+1). */
    async usageCountByCanvas(canvasIds: readonly string[]): Promise<Map<string, number>> {
      if (canvasIds.length === 0) return new Map();
      const rows = (await db
        .select({ canvasId: usageT.canvasId, ops: sql<number>`count(*)` })
        .from(usageT)
        .where(inArray(usageT.canvasId, [...canvasIds]))
        .groupBy(usageT.canvasId)) as Array<{ canvasId: string; ops: number }>;
      return new Map(rows.map((r) => [r.canvasId, Number(r.ops)]));
    },
  };
}

export type AdminRepository = ReturnType<typeof adminRepository>;

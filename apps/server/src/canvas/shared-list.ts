import { computeSearchText, normalize } from "@canvas-drop/shared";
import type { Canvas } from "@canvas-drop/shared/db";
import type { CanvasesRepository } from "../db/repositories/canvases.js";
import type { TeamsRepository } from "../db/repositories/teams.js";
import type { UsersRepository } from "../db/repositories/users.js";

export type SharedCanvasAccess =
  | { kind: "direct"; label: "Direct" }
  | { kind: "team"; label: string; teamIds: string[]; teamNames: string[] }
  | { kind: "whole_org"; label: "Whole org" };

export interface SharedCanvasItem {
  canvas: Canvas;
  owner: { id: string; name: string; avatarUrl: string | null } | null;
  access: SharedCanvasAccess;
}

export type SharedCanvasSort = "updated" | "title" | "owner";

export interface SharedCanvasListOptions {
  viewerId: string;
  viewerOrgIds: Set<string>;
  tenancyActive: boolean;
  now: number;
  q?: string;
  sort?: SharedCanvasSort;
  limit: number;
  offset: number;
}

interface Candidate {
  canvas: Canvas;
  access: SharedCanvasAccess;
  priority: number;
}

type SharedListDeps = {
  canvases: Pick<
    CanvasesRepository,
    "findByIds" | "listDirectSharedWithUser" | "listWholeOrgSharedWithUser"
  >;
  teams: Pick<TeamsRepository, "listCanvasGrantsForUserTeams">;
  users: Pick<UsersRepository, "findByIds">;
};

function canvasTags(cv: Canvas): string[] | null {
  return Array.isArray(cv.tags)
    ? cv.tags.filter((tag): tag is string => typeof tag === "string")
    : null;
}

function liveTeamCanvas(cv: Canvas, viewerId: string, now: number): boolean {
  return (
    cv.ownerId !== viewerId &&
    cv.access === "team" &&
    cv.discoverability === "listed" &&
    cv.status === "active" &&
    cv.currentVersionId !== null &&
    (cv.sharedExpiresAt === null || cv.sharedExpiresAt > now)
  );
}

function matchesQuery(item: SharedCanvasItem, q: string | undefined): boolean {
  if (!q) return true;
  const tokens = normalize(q).split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  const cv = item.canvas;
  const canvasText =
    cv.searchText ??
    computeSearchText({
      title: cv.title,
      description: cv.description,
      tags: canvasTags(cv),
      slug: cv.slug,
    });
  const accessText =
    item.access.kind === "team" ? item.access.teamNames.join(" ") : item.access.label;
  const haystack = normalize([canvasText, item.owner?.name ?? "", accessText].join(" "));
  return tokens.every((token) => haystack.includes(token));
}

function compareShared(sort: SharedCanvasSort, a: SharedCanvasItem, b: SharedCanvasItem): number {
  if (sort === "title") {
    return (
      normalize(a.canvas.title || "Untitled canvas").localeCompare(
        normalize(b.canvas.title || "Untitled canvas"),
      ) || (a.canvas.id < b.canvas.id ? 1 : -1)
    );
  }
  if (sort === "owner") {
    return (
      normalize(a.owner?.name ?? "").localeCompare(normalize(b.owner?.name ?? "")) ||
      normalize(a.canvas.title || "Untitled canvas").localeCompare(
        normalize(b.canvas.title || "Untitled canvas"),
      ) ||
      (a.canvas.id < b.canvas.id ? 1 : -1)
    );
  }
  return b.canvas.updatedAt - a.canvas.updatedAt || (a.canvas.id < b.canvas.id ? 1 : -1);
}

function addCandidate(candidates: Map<string, Candidate>, next: Candidate) {
  const current = candidates.get(next.canvas.id);
  if (!current || next.priority < current.priority) candidates.set(next.canvas.id, next);
}

/**
 * Canonical non-owned Shared listing. HTTP and MCP both call this service, so the
 * access-path rules and display projection cannot drift. All search/paging happens
 * after the candidate queries have already scoped to rows the viewer can access.
 */
export async function listSharedCanvases(
  deps: SharedListDeps,
  opts: SharedCanvasListOptions,
): Promise<{ items: SharedCanvasItem[]; total: number }> {
  const candidates = new Map<string, Candidate>();

  const [direct, teamGrants, wholeOrg] = await Promise.all([
    deps.canvases.listDirectSharedWithUser(opts.viewerId, opts.now),
    deps.teams.listCanvasGrantsForUserTeams(opts.viewerId, opts.viewerOrgIds),
    deps.canvases.listWholeOrgSharedWithUser(
      {
        viewerId: opts.viewerId,
        viewerOrgIds: opts.viewerOrgIds,
        tenancyActive: opts.tenancyActive,
      },
      opts.now,
    ),
  ]);

  for (const cv of direct) {
    addCandidate(candidates, {
      canvas: cv,
      access: { kind: "direct", label: "Direct" },
      priority: 0,
    });
  }

  const teamsByCanvas = new Map<string, Array<{ teamId: string; teamName: string }>>();
  for (const grant of teamGrants) {
    const list = teamsByCanvas.get(grant.canvasId) ?? [];
    list.push({ teamId: grant.teamId, teamName: grant.teamName });
    teamsByCanvas.set(grant.canvasId, list);
  }
  const teamRows = await deps.canvases.findByIds([...teamsByCanvas.keys()]);
  for (const cv of teamRows) {
    if (!liveTeamCanvas(cv, opts.viewerId, opts.now)) continue;
    const grants = teamsByCanvas.get(cv.id) ?? [];
    const unique = [...new Map(grants.map((g) => [g.teamId, g])).values()].sort((a, b) =>
      a.teamName.localeCompare(b.teamName),
    );
    const teamNames = unique.map((g) => g.teamName);
    addCandidate(candidates, {
      canvas: cv,
      access: {
        kind: "team",
        label: teamNames.join(", "),
        teamIds: unique.map((g) => g.teamId),
        teamNames,
      },
      priority: 1,
    });
  }

  for (const cv of wholeOrg) {
    addCandidate(candidates, {
      canvas: cv,
      access: { kind: "whole_org", label: "Whole org" },
      priority: 2,
    });
  }

  const ownerIds = [...new Set([...candidates.values()].map((c) => c.canvas.ownerId))];
  const owners = new Map((await deps.users.findByIds(ownerIds)).map((u) => [u.id, u]));
  const items = [...candidates.values()]
    .map(({ canvas, access }) => {
      const owner = owners.get(canvas.ownerId);
      return {
        canvas,
        access,
        owner: owner
          ? { id: owner.id, name: owner.name, avatarUrl: owner.avatarUrl ?? null }
          : null,
      };
    })
    .filter((item) => matchesQuery(item, opts.q))
    .sort((a, b) => compareShared(opts.sort ?? "updated", a, b));

  const total = items.length;
  return { items: items.slice(opts.offset, opts.offset + opts.limit), total };
}

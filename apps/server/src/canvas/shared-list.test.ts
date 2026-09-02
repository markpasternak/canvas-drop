import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { listSharedCanvases } from "./shared-list.js";

/**
 * Shared discovery vs the owned-or-edited main list (editor-roles plan U9, KD9/R15):
 * a canvas the viewer EDITS never appears under Shared — it lives in the main list with
 * the management surface; a canvas they merely VIEW still does.
 */
describe.each(DIALECTS)("listSharedCanvases — editor exclusion [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function publish(canvasId: string, ownerId: string) {
    const versions = versionsRepository(client);
    const v = await versions.createPending({
      canvasId,
      number: 1,
      createdBy: ownerId,
      source: "api",
    });
    await versions.markReady(v.id, { fileCount: 1, totalBytes: 1, manifest: {} });
    await canvasesRepository(client).setCurrentVersion(canvasId, v.id);
  }

  it("excludes canvases the viewer edits directly or via an editor team; keeps a viewer-role share", async () => {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const teams = teamsRepository(client);
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "O",
      isAdmin: false,
    });
    const me = await users.upsert({
      providerSub: "m",
      email: "m@e.com",
      name: "M",
      isAdmin: false,
    });
    const mk = async (slug: string) => {
      const cv = await canvases.create({ ownerId: owner.id, slug, apiKeyHash: slug });
      await publish(cv.id, owner.id);
      await canvases.setAccess(cv.id, "specific_people");
      return cv;
    };
    const edited = await mk("edited");
    const viaTeam = await mk("via-team");
    const viewed = await mk("viewed");
    await canvases.addAllowlistEntry({
      canvasId: edited.id,
      principalKind: "member",
      userId: me.id,
      role: "editor",
    });
    await canvases.addAllowlistEntry({
      canvasId: viewed.id,
      principalKind: "member",
      userId: me.id,
    });
    // The team canvas: team rung + listed, with an EDITOR-role team grant containing me.
    const team = await teams.create({ orgId: null, name: "Eng", createdBy: owner.id });
    await teams.addMember(team.id, me.id);
    await canvases.setAccess(viaTeam.id, "team");
    await canvases.updateSettings(viaTeam.id, { discoverability: "listed" });
    await teams.setCanvasTeamRole(viaTeam.id, team.id, "editor");
    // A second team canvas with a VIEWER-role grant stays in Shared.
    const teamViewed = await mk("team-viewed");
    await canvases.setAccess(teamViewed.id, "team");
    await canvases.updateSettings(teamViewed.id, { discoverability: "listed" });
    await teams.setCanvasTeamRole(teamViewed.id, team.id, "viewer");

    const { items, total } = await listSharedCanvases(
      { canvases, teams, users },
      {
        viewerId: me.id,
        viewerOrgIds: new Set(),
        tenancyActive: false,
        now: Date.now(),
        limit: 50,
        offset: 0,
      },
    );
    expect(items.map((i) => i.canvas.slug).sort()).toEqual(["team-viewed", "viewed"]);
    expect(total).toBe(2);
    // Demote the direct editor → the canvas returns to Shared on the next call.
    const row = await canvases.findMemberEntry(edited.id, me.id);
    await canvases.setAllowlistRole(edited.id, (row as { id: string }).id, "viewer");
    const after = await listSharedCanvases(
      { canvases, teams, users },
      {
        viewerId: me.id,
        viewerOrgIds: new Set(),
        tenancyActive: false,
        now: Date.now(),
        limit: 50,
        offset: 0,
      },
    );
    expect(after.items.map((i) => i.canvas.slug).sort()).toEqual([
      "edited",
      "team-viewed",
      "viewed",
    ]);
  });

  it("lists direct and team grants at EVERY rung — private included, no discoverability opt-in needed (restricted access model)", async () => {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const teams = teamsRepository(client);
    const owner = await users.upsert({
      providerSub: "o2",
      email: "o2@e.com",
      name: "O",
      isAdmin: false,
    });
    const me = await users.upsert({
      providerSub: "m2",
      email: "m2@e.com",
      name: "M",
      isAdmin: false,
    });
    const mk = async (slug: string, access: "private" | "team" | "whole_org" | "public_link") => {
      const cv = await canvases.create({ ownerId: owner.id, slug, apiKeyHash: slug });
      await publish(cv.id, owner.id);
      await canvases.setAccess(cv.id, access);
      return cv;
    };
    // A direct viewer grant on a PRIVATE canvas (the rung was never flipped).
    const direct = await mk("direct-private", "private");
    await canvases.addAllowlistEntry({
      canvasId: direct.id,
      principalKind: "member",
      userId: me.id,
    });
    // A viewer-team grant on a private canvas, discoverability left at its default.
    const team = await teams.create({ orgId: null, name: "Eng", createdBy: owner.id });
    await teams.addMember(team.id, me.id);
    const viaTeam = await mk("team-private", "private");
    await teams.setCanvasTeamRole(viaTeam.id, team.id, "viewer");
    // A team-rung canvas that stayed link_only (legacy) now lists for its team too.
    const legacyLinkOnly = await mk("team-link-only", "team");
    await teams.setCanvasTeamRole(legacyLinkOnly.id, team.id, "viewer");
    // A public canvas with a direct grant is still "shared with me".
    const pub = await mk("public-direct", "public_link");
    await canvases.addAllowlistEntry({ canvasId: pub.id, principalKind: "member", userId: me.id });
    // Control: a private canvas with no grant never appears.
    await mk("private-none", "private");
    // Control: a whole_org canvas still needs the listing opt-in to enumerate for non-grantees.
    await mk("org-link-only", "whole_org");

    const { items } = await listSharedCanvases(
      { canvases, teams, users },
      {
        viewerId: me.id,
        viewerOrgIds: new Set(),
        tenancyActive: false,
        now: Date.now(),
        limit: 50,
        offset: 0,
      },
    );
    expect(items.map((i) => i.canvas.slug).sort()).toEqual([
      "direct-private",
      "public-direct",
      "team-link-only",
      "team-private",
    ]);
    const byslug = new Map(items.map((i) => [i.canvas.slug, i.access.kind]));
    expect(byslug.get("direct-private")).toBe("direct");
    expect(byslug.get("team-private")).toBe("team");
  });
});

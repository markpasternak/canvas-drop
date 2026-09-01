import { type Config, loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import { searchPersonSuggestions } from "./search.js";

const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });

/**
 * The add-person picker's canvas context authorizes through the shared role resolver
 * (editor-roles plan U3): owner OR editor get suggestions; a viewer or a member with no
 * role reads not_found (no existence leak).
 */
describe("searchPersonSuggestions — canvas context role gate", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seed() {
    client = await makeTestDb("sqlite");
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const mk = (sub: string, name = sub) =>
      users.upsert({ providerSub: sub, email: `${sub}@example.com`, name, isAdmin: false });
    const owner = await mk("owner", "Olive Owner");
    const editor = await mk("editor", "Edna Editor");
    const viewer = await mk("viewer", "Vic Viewer");
    const nobody = await mk("nobody", "Nia Nobody");
    const candidate = await mk("candidate", "Cass Candidate");
    const canvas = await canvases.create({ ownerId: owner.id, slug: "deck", apiKeyHash: "k" });
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: viewer.id,
    });
    const deps = {
      config,
      canvases,
      teams: teamsRepository(client),
      users,
      orgMembers: orgMembersRepository(client),
    };
    const actor = (u: { id: string }) => ({ id: u.id, isAdmin: false, orgIds: new Set<string>() });
    const search = (u: { id: string }) =>
      searchPersonSuggestions(deps, actor(u), {
        context: "canvas",
        canvasId: canvas.id,
        q: "Cass",
      });
    return { owner, editor, viewer, nobody, candidate, canvas, search };
  }

  it("a viewer-role member and a no-role member read not_found", async () => {
    const { viewer, nobody, search } = await seed();
    expect(await search(viewer)).toEqual({ ok: false, error: "not_found" });
    expect(await search(nobody)).toEqual({ ok: false, error: "not_found" });
  });

  it("the owner AND an editor get suggestions (people already listed are excluded)", async () => {
    const { owner, editor, candidate, search } = await seed();
    const asOwner = await search(owner);
    expect(asOwner.ok).toBe(true);
    if (asOwner.ok) expect(asOwner.people.map((p) => p.id)).toEqual([candidate.id]);
    const asEditor = await search(editor);
    expect(asEditor.ok).toBe(true);
    if (asEditor.ok) expect(asEditor.people.map((p) => p.id)).toEqual([candidate.id]);
  });

  it("an unknown canvas id reads not_found for everyone", async () => {
    const { owner, canvas } = await seed();
    const deps = {
      config,
      canvases: canvasesRepository(client),
      teams: teamsRepository(client),
      users: usersRepository(client),
      orgMembers: orgMembersRepository(client),
    };
    expect(
      await searchPersonSuggestions(
        deps,
        { id: owner.id, isAdmin: false, orgIds: new Set() },
        { context: "canvas", canvasId: `${canvas.id}-nope`, q: "x" },
      ),
    ).toEqual({ ok: false, error: "not_found" });
  });
});

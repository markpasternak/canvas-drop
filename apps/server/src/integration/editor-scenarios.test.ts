import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { DbClient } from "../db/factory.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { CLOSE_UNAUTHORIZED } from "../realtime/hub.js";
import {
  connectMcp,
  type Harness,
  jsonOf,
  makeHarness,
  mcpIsError,
  scenarioConfig,
} from "./scenario-harness.js";

/**
 * Lifecycle + collision scenarios for canvas editor roles (editor-roles plan U12; R5, R22,
 * AE12, AE18, KTD14) over the REAL composed app — gateway → orgIds → role resolver →
 * management / draft / MCP / realtime. The headline invariant: a role change (removal,
 * demotion, org departure, transfer) takes effect on the NEXT request on every surface,
 * with no reconcile job and no timing beyond "next request" (the realtime sweep is the
 * heartbeat the server runs; the scenario invokes it directly).
 */

const OWNER = "owner@example.com"; // Acme member; canvas owner
const EDITOR = "editor@example.com"; // Acme member; granted editor
const MATE = "mate@contractor.test"; // Acme member via the contractor.test domain
const NEWBIE = "newbie@example.com"; // never signed in before the scenario needs them

function editorConfig() {
  return scenarioConfig({
    CANVAS_DROP_ORG_NAME: "Acme",
    CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com,contractor.test",
  });
}

async function seedAcme(client: DbClient): Promise<string> {
  const org = await orgsRepository(client).ensureOrg({
    name: "Acme",
    slug: "acme",
    domains: ["example.com", "contractor.test"],
  });
  return org.id;
}

/** Sign everyone in once (materializes org membership) and publish a backend-on canvas. */
async function setupCanvas(
  h: Harness,
  people: string[],
): Promise<{ canvasId: string; slug: string }> {
  for (const who of people) await (await h.GET(who, "/api/me")).text();
  const pasteRes = await h.SEND(OWNER, "POST", "/api/canvases/paste", {
    html: "<h1>owner content</h1>",
    title: "Roles doc",
    backendEnabled: true,
  });
  expect(pasteRes.status).toBe(201);
  const cv = await jsonOf<{ id: string; slug: string }>(pasteRes);
  return { canvasId: cv.id, slug: cv.slug };
}

function timeout(ms: number, what: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms),
  );
}

async function userId(client: DbClient, email: string): Promise<string> {
  const u = await usersRepository(client).findByEmail(email);
  if (!u) throw new Error(`seed: ${email} missing`);
  return u.id;
}

/** Raw-body draft write as `email` (the same route the dashboard autosave uses), carrying
 *  the file's current hash as `If-Draft-File-Hash` the way the editor does — a write with
 *  no precondition is refused whenever another user wrote the entry last (KTD8). A caller
 *  who can't read the draft sends none (and is expected to be refused anyway). */
async function putDraft(h: Harness, email: string, canvasId: string, content: string) {
  const view = await h.GET(email, `/api/canvases/${canvasId}/draft`);
  let hash: string | undefined;
  if (view.status === 200) {
    const { files } = await jsonOf<{ files: Array<{ path: string; hash: string }> }>(view);
    hash = files.find((f) => f.path === "index.html")?.hash;
  } else {
    await view.text();
  }
  return h.app.request(`/api/canvases/${canvasId}/draft/file?path=index.html`, {
    method: "PUT",
    headers: h.headers(email, {
      "Sec-Fetch-Site": "same-origin",
      "content-type": "application/octet-stream",
      ...(hash ? { "If-Draft-File-Hash": hash } : {}),
    }),
    body: content,
  });
}

async function roleOf(h: Harness, email: string, canvasId: string): Promise<string | null> {
  const res = await h.GET(email, `/api/canvases/${canvasId}`);
  if (res.status === 404) {
    await res.text();
    return null;
  }
  expect(res.status).toBe(200);
  return (await jsonOf<{ role: string }>(res)).role;
}

/** The people-list entry id for `email` (`member:<rowId>` / `pending:<invitationId>`). */
async function entryIdFor(
  h: Harness,
  canvasId: string,
  email: string,
  actor = OWNER,
): Promise<string> {
  const res = await h.GET(actor, `/api/canvases/${canvasId}/allowlist`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries?: PeopleRow[] } | PeopleRow[];
  const entries = Array.isArray(body) ? body : (body.entries ?? []);
  const hit = entries.find((e) => e.email?.toLowerCase() === email.toLowerCase());
  if (!hit) throw new Error(`people list has no entry for ${email}`);
  return hit.id;
}
interface PeopleRow {
  id: string;
  email?: string | null;
  role?: string;
}

async function grant(
  h: Harness,
  canvasId: string,
  body: { email?: string; teamId?: string; role?: "viewer" | "editor" },
) {
  const res = await h.SEND(OWNER, "POST", `/api/canvases/${canvasId}/allowlist`, body);
  expect([200, 201]).toContain(res.status);
  await res.text();
}

describe.each(DIALECTS)("editor role scenarios [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("F1/F4/F6/F7: two editors collaborate with conflict protection, then ownership transfers and the former owner is demoted and removed", async () => {
    client = await makeTestDb(dialect);
    await seedAcme(client);
    const h = makeHarness(client, { config: editorConfig() });
    const { canvasId, slug } = await setupCanvas(h, [OWNER, EDITOR, MATE]);
    const editorId = await userId(client, EDITOR);

    // F1: direct people-list grants make both colleagues effective editors immediately.
    await grant(h, canvasId, { email: EDITOR, role: "editor" });
    await grant(h, canvasId, { email: MATE, role: "editor" });
    expect(await roleOf(h, EDITOR, canvasId)).toBe("editor");
    expect(await roleOf(h, MATE, canvasId)).toBe("editor");

    // F7: both editors open the same file at the same version. The first write lands;
    // the second carries the now-stale hash and is refused instead of overwriting it.
    expect((await putDraft(h, EDITOR, canvasId, "<h1>baseline</h1>")).status).toBe(200);
    const open = await h.GET(EDITOR, `/api/canvases/${canvasId}/draft`);
    const { files } = await jsonOf<{ files: Array<{ path: string; hash: string }> }>(open);
    const sharedHash = files.find((file) => file.path === "index.html")?.hash;
    if (!sharedHash) throw new Error("index.html hash missing");

    const first = await h.app.request(`/api/canvases/${canvasId}/draft/file?path=index.html`, {
      method: "PUT",
      headers: h.headers(EDITOR, {
        "Sec-Fetch-Site": "same-origin",
        "content-type": "application/octet-stream",
        "If-Draft-File-Hash": sharedHash,
      }),
      body: "<h1>editor wins</h1>",
    });
    expect(first.status).toBe(200);
    await first.text();
    const stale = await h.app.request(`/api/canvases/${canvasId}/draft/file?path=index.html`, {
      method: "PUT",
      headers: h.headers(MATE, {
        "Sec-Fetch-Site": "same-origin",
        "content-type": "application/octet-stream",
        "If-Draft-File-Hash": sharedHash,
      }),
      body: "<h1>mate overwrites</h1>",
    });
    expect(stale.status).toBe(409);
    expect(await jsonOf<{ code: string; path: string }>(stale)).toMatchObject({
      code: "DRAFT_CONFLICT",
      path: "index.html",
    });
    expect((await putDraft(h, MATE, canvasId, "<h1>mate after refresh</h1>")).status).toBe(200);

    // F4: transfer is owner-only and promotes the chosen direct editor; the former
    // owner remains an editor so the hand-off does not strand their work.
    const transfer = await h.SEND(OWNER, "POST", `/api/canvases/${canvasId}/transfer`, {
      toUserId: editorId,
    });
    expect(transfer.status).toBe(200);
    await transfer.text();
    expect(await roleOf(h, EDITOR, canvasId)).toBe("owner");
    expect(await roleOf(h, OWNER, canvasId)).toBe("editor");

    // F6: the new owner can demote and then remove the former owner. Demotion retains
    // view access through the row; removal closes the Restricted canvas completely.
    const formerOwnerEntry = await entryIdFor(h, canvasId, OWNER, EDITOR);
    const demote = await h.SEND(
      EDITOR,
      "PATCH",
      `/api/canvases/${canvasId}/allowlist/${formerOwnerEntry}`,
      { role: "viewer" },
    );
    expect(demote.status).toBe(200);
    await demote.text();
    expect(await roleOf(h, OWNER, canvasId)).toBeNull();
    expect((await h.GET(OWNER, `/c/${slug}/`)).status).toBe(200);

    const remove = await h.SEND(
      EDITOR,
      "DELETE",
      `/api/canvases/${canvasId}/allowlist/${formerOwnerEntry}`,
    );
    expect([200, 204]).toContain(remove.status);
    await remove.text();
    const gone = await h.GET(OWNER, `/c/${slug}/`);
    expect(gone.status).toBe(404);
    await gone.text();
  });

  it("AE12: a demoted editor loses management, draft and MCP on the next request; the live socket survives as a viewer and drops once the row is removed", async () => {
    client = await makeTestDb(dialect);
    const acmeId = await seedAcme(client);
    const h = makeHarness(client, { config: editorConfig() });
    const { canvasId, slug } = await setupCanvas(h, [OWNER, EDITOR]);
    const editorId = await userId(client, EDITOR);
    const caps = await h.SEND(OWNER, "PATCH", `/api/canvases/${canvasId}/capabilities`, {
      realtime: true,
    });
    expect(caps.status).toBe(200);
    await caps.text();

    await grant(h, canvasId, { email: EDITOR, role: "editor" });

    // Baseline: the editor manages the canvas on every surface.
    expect(await roleOf(h, EDITOR, canvasId)).toBe("editor");
    expect((await putDraft(h, EDITOR, canvasId, "<h1>editor draft</h1>")).status).toBe(200);
    const mcp = await connectMcp(h, {
      userId: editorId,
      orgIds: new Set([acmeId]),
      tenancyActive: true,
    });
    expect(
      mcpIsError(await mcp.callTool({ name: "get_canvas", arguments: { id: canvasId } })),
    ).toBe(false);

    const server = await h.listen();
    let sock: WebSocket | null = null;
    try {
      // The editor holds a live socket on the PRIVATE canvas purely by role.
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/c/${slug}/realtime`, {
        headers: h.headers(EDITOR),
      });
      sock = ws;
      const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      const opened = new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("unexpected-response", (_req, res) =>
          reject(new Error(`handshake refused: ${res.statusCode}`)),
        );
        ws.once("error", reject);
      });
      await Promise.race([opened, timeout(3000, "socket open")]);

      // The owner demotes the editor to viewer.
      const demote = await h.SEND(
        OWNER,
        "PATCH",
        `/api/canvases/${canvasId}/allowlist/${await entryIdFor(h, canvasId, EDITOR)}`,
        { role: "viewer" },
      );
      expect(demote.status).toBe(200);
      await demote.text();

      // The realtime sweep (what the heartbeat runs) KEEPS the socket: demotion removes the
      // management role, not the door — a listed viewer opens the canvas at every rung
      // (restricted access model), private included.
      await h.hub.revalidateCanvas(canvasId);
      // `dropConn` removes the connection synchronously inside the sweep, so the count is
      // a deterministic witness that the socket survived (no wall-clock race).
      expect(h.hub.connectionCount(canvasId)).toBe(1);
      // Removing the row closes the door, and with it the socket (unauthorized close code).
      const revoke = await h.SEND(
        OWNER,
        "DELETE",
        `/api/canvases/${canvasId}/allowlist/${await entryIdFor(h, canvasId, EDITOR)}`,
      );
      expect([200, 204]).toContain(revoke.status);
      await revoke.text();
      await h.hub.revalidateCanvas(canvasId);
      expect(h.hub.connectionCount(canvasId)).toBe(0);
      expect(await Promise.race([closed, timeout(3000, "socket close")])).toBe(CLOSE_UNAUTHORIZED);
    } finally {
      // A still-open client socket would hold the server's close() forever.
      sock?.terminate();
      await server.close();
    }

    // Next request on every other surface: not found (a viewer has no management role).
    expect(await roleOf(h, EDITOR, canvasId)).toBeNull();
    const put = await putDraft(h, EDITOR, canvasId, "<h1>too late</h1>");
    expect(put.status).toBe(404);
    await put.text();
    const again = await mcp.callTool({ name: "get_canvas", arguments: { id: canvasId } });
    expect(mcpIsError(again)).toBe(true);
    // The owner's draft content is exactly what the editor last saved — nothing after.
    const draft = await h.GET(OWNER, `/api/canvases/${canvasId}/draft/file?path=index.html`);
    expect(await draft.text()).toBe("<h1>editor draft</h1>");
  });

  it("AE18: the owner removed from an editor team is still the owner — every owner route succeeds", async () => {
    client = await makeTestDb(dialect);
    const acmeId = await seedAcme(client);
    const h = makeHarness(client, { config: editorConfig() });
    const { canvasId } = await setupCanvas(h, [OWNER, EDITOR]);
    const ownerId = await userId(client, OWNER);

    // EDITOR creates the team and adds the OWNER; the owner grants that team editor.
    const teamRes = await h.SEND(EDITOR, "POST", "/api/teams", { orgId: acmeId, name: "Design" });
    expect(teamRes.status).toBe(201);
    const { team } = await jsonOf<{ team: { id: string } }>(teamRes);
    const add = await h.SEND(EDITOR, "POST", `/api/teams/${team.id}/members`, { email: OWNER });
    expect(add.status).toBe(200);
    await add.text();
    await grant(h, canvasId, { teamId: team.id, role: "editor" });
    expect(await teamsRepository(client).isTeamMember(team.id, ownerId)).toBe(true);
    expect(await roleOf(h, OWNER, canvasId)).toBe("owner");

    // The team creator removes the owner from the editor team.
    const remove = await h.SEND(EDITOR, "DELETE", `/api/teams/${team.id}/members/${ownerId}`);
    expect([200, 204]).toContain(remove.status);
    await remove.text();
    expect(await teamsRepository(client).isTeamMember(team.id, ownerId)).toBe(false);

    // Still the owner: read, settings, draft, people list, and the owner-only delete.
    expect(await roleOf(h, OWNER, canvasId)).toBe("owner");
    const settings = await h.SEND(OWNER, "PATCH", `/api/canvases/${canvasId}/settings`, {
      title: "Still mine",
    });
    expect(settings.status).toBe(200);
    await settings.text();
    expect((await putDraft(h, OWNER, canvasId, "<h1>owner edit</h1>")).status).toBe(200);
    const people = await h.GET(OWNER, `/api/canvases/${canvasId}/allowlist`);
    expect(people.status).toBe(200);
    await people.text();
    // And the teammate who stayed on the team is an editor, not an owner.
    expect(await roleOf(h, EDITOR, canvasId)).toBe("editor");
    const del = await h.SEND(OWNER, "DELETE", `/api/canvases/${canvasId}`);
    expect([200, 204]).toContain(del.status);
    await del.text();
  });

  it("viewer row + editor team: edits while the team grant stands; view-only via the row once it is removed", async () => {
    client = await makeTestDb(dialect);
    const acmeId = await seedAcme(client);
    const h = makeHarness(client, { config: editorConfig() });
    const { canvasId, slug } = await setupCanvas(h, [OWNER, EDITOR]);

    // A viewer row for EDITOR on a specific_people canvas...
    await grant(h, canvasId, { email: EDITOR });
    const rung = await h.SEND(OWNER, "PATCH", `/api/canvases/${canvasId}/settings`, {
      access: "specific_people",
    });
    expect(rung.status).toBe(200);
    await rung.text();
    // ...plus an editor grant through a team they are on.
    const teamRes = await h.SEND(OWNER, "POST", "/api/teams", { orgId: acmeId, name: "Design" });
    const { team } = await jsonOf<{ team: { id: string } }>(teamRes);
    const add = await h.SEND(OWNER, "POST", `/api/teams/${team.id}/members`, { email: EDITOR });
    expect(add.status).toBe(200);
    await add.text();
    await grant(h, canvasId, { teamId: team.id, role: "editor" });

    // The editor team wins: they manage and edit.
    expect(await roleOf(h, EDITOR, canvasId)).toBe("editor");
    expect((await putDraft(h, EDITOR, canvasId, "<h1>team edit</h1>")).status).toBe(200);

    // Remove the team grant → view only, through the row that never went away.
    const remove = await h.SEND(
      OWNER,
      "DELETE",
      `/api/canvases/${canvasId}/allowlist/team:${team.id}`,
    );
    expect([200, 204]).toContain(remove.status);
    await remove.text();
    expect(await roleOf(h, EDITOR, canvasId)).toBeNull();
    const put = await putDraft(h, EDITOR, canvasId, "<h1>no longer</h1>");
    expect(put.status).toBe(404);
    await put.text();
    const view = await h.GET(EDITOR, `/c/${slug}/`);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("owner content");
  });

  it("org departure: the editor row lingers but reads as no role on the next request (no reconcile)", async () => {
    client = await makeTestDb(dialect);
    const acmeId = await seedAcme(client);
    const h = makeHarness(client, { config: editorConfig() });
    const { canvasId, slug } = await setupCanvas(h, [OWNER, MATE]);
    const mateId = await userId(client, MATE);
    await grant(h, canvasId, { email: MATE, role: "editor" });
    expect(await roleOf(h, MATE, canvasId)).toBe("editor");
    expect((await putDraft(h, MATE, canvasId, "<h1>mate edit</h1>")).status).toBe(200);

    // The operator drops contractor.test from Acme and revokes the explicit membership —
    // no reconcile: the editor row stays exactly as it was.
    await orgsRepository(client).ensureOrg({
      name: "Acme",
      slug: "acme",
      domains: ["example.com"],
    });
    await orgMembersRepository(client).remove(acmeId, mateId);
    const row = await h.repos.canvases.findMemberEntry(canvasId, mateId);
    expect(row?.role).toBe("editor");

    // Next request: no management role anywhere — management and the draft are gone…
    expect(await roleOf(h, MATE, canvasId)).toBeNull();
    const put = await putDraft(h, MATE, canvasId, "<h1>outsider</h1>");
    expect(put.status).toBe(404);
    await put.text();
    // …but the lingering row still names them on the people-and-teams list, and the list
    // applies at every rung (restricted access model): they keep VIEW access exactly like
    // any invited outsider until the owner removes the row. Editing power alone is org-scoped.
    const view = await h.GET(MATE, `/c/${slug}/`);
    expect(view.status).toBe(200);
    await view.text();
    const revoke = await h.SEND(
      OWNER,
      "DELETE",
      `/api/canvases/${canvasId}/allowlist/member:${(row as { id: string }).id}`,
    );
    expect([200, 204]).toContain(revoke.status);
    await revoke.text();
    const gone = await h.GET(MATE, `/c/${slug}/`);
    expect(gone.status).toBe(404);
    await gone.text();
    // The owner-visible draft is untouched by the refused write.
    const draft = await h.GET(OWNER, `/api/canvases/${canvasId}/draft/file?path=index.html`);
    expect(await draft.text()).toBe("<h1>mate edit</h1>");
  });

  it("a pending editor invite survives a transfer and materializes under the new owner as editor", async () => {
    client = await makeTestDb(dialect);
    await seedAcme(client);
    const h = makeHarness(client, { config: editorConfig() });
    const { canvasId } = await setupCanvas(h, [OWNER, EDITOR]);
    const editorId = await userId(client, EDITOR);

    // Invite someone who has never signed in, as an editor; grant EDITOR and hand over.
    // An admissible org-domain email that has never signed in becomes a PENDING entry
    // (auth-delegated Add person), carrying the invited role.
    const invite = await h.SEND(OWNER, "POST", `/api/canvases/${canvasId}/allowlist`, {
      email: NEWBIE,
      role: "editor",
    });
    const inviteBody = await invite.text();
    expect(`${invite.status} ${inviteBody}`).toMatch(/^20[01] .*pending/);
    await grant(h, canvasId, { email: EDITOR, role: "editor" });
    const transfer = await h.SEND(OWNER, "POST", `/api/canvases/${canvasId}/transfer`, {
      toUserId: editorId,
    });
    expect(transfer.status).toBe(200);
    await transfer.text();
    expect(await roleOf(h, EDITOR, canvasId)).toBe("owner");
    expect(await roleOf(h, OWNER, canvasId)).toBe("editor");

    // The invitee's first sign-in materializes the grant — under the NEW owner, as editor.
    await (await h.GET(NEWBIE, "/api/me")).text();
    expect(await roleOf(h, NEWBIE, canvasId)).toBe("editor");
    const newbieId = await userId(client, NEWBIE);
    expect((await h.repos.canvases.findMemberEntry(canvasId, newbieId))?.role).toBe("editor");
    expect((await putDraft(h, NEWBIE, canvasId, "<h1>newbie</h1>")).status).toBe(200);
    // The new owner's people list carries them as an editor.
    const people = await h.GET(EDITOR, `/api/canvases/${canvasId}/allowlist`);
    expect(people.status).toBe(200);
    const { entries } = await jsonOf<{ entries: PeopleRow[] }>(people);
    expect(entries.find((e) => e.email === NEWBIE)).toMatchObject({ role: "editor" });
    // ...and the previous owner now sits in it as an editor.
    expect(entries.find((e) => e.email === OWNER)).toMatchObject({ role: "editor" });
  });

  it("review #7/#15: the owner's people list carries transfer candidates from editor TEAMS; re-adding a team without a role keeps it an editor", async () => {
    client = await makeTestDb(dialect);
    const acmeId = await seedAcme(client);
    const h = makeHarness(client, { config: editorConfig() });
    const { canvasId } = await setupCanvas(h, [OWNER, EDITOR, MATE]);
    const editorId = await userId(client, EDITOR);
    const mateId = await userId(client, MATE);

    // MATE becomes an editor only through a team; EDITOR directly.
    const teamRes = await h.SEND(OWNER, "POST", "/api/teams", { orgId: acmeId, name: "Design" });
    const { team } = await jsonOf<{ team: { id: string } }>(teamRes);
    const add = await h.SEND(OWNER, "POST", `/api/teams/${team.id}/members`, { email: MATE });
    expect(add.status).toBe(200);
    await add.text();
    await grant(h, canvasId, { teamId: team.id, role: "editor" });
    await grant(h, canvasId, { email: EDITOR, role: "editor" });

    // The owner sees BOTH as transfer candidates (team-derived editors included).
    const owned = await h.GET(OWNER, `/api/canvases/${canvasId}/allowlist`);
    const body = await jsonOf<{ transferCandidates?: Array<{ id: string }> }>(owned);
    expect((body.transferCandidates ?? []).map((c) => c.id).sort()).toEqual(
      [editorId, mateId].sort(),
    );
    // An editor sees no candidates at all (owner-only projection).
    const asEditor = await h.GET(EDITOR, `/api/canvases/${canvasId}/allowlist`);
    expect(
      (await jsonOf<{ transferCandidates?: unknown }>(asEditor)).transferCandidates,
    ).toBeUndefined();

    // Re-adding the team with NO role must not demote it (review #15).
    const again = await h.SEND(OWNER, "POST", `/api/canvases/${canvasId}/allowlist`, {
      teamId: team.id,
    });
    expect(again.status).toBe(200);
    expect(await jsonOf<{ status: string; role: string }>(again)).toMatchObject({
      status: "already_added",
      role: "editor",
    });
    expect(await roleOf(h, MATE, canvasId)).toBe("editor");
  });
});

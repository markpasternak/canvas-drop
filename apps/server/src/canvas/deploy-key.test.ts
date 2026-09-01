import { afterEach, describe, expect, it } from "vitest";
import type { AuditLog, RecordAuditInput } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { hashApiKey } from "./api-key.js";
import { rotateDeployKey } from "./deploy-key.js";

/** Deploy-key rotation (editor-roles plan U8, KTD11/AE19): audited with the acting role;
 *  a rotation by a non-owner emails the owner naming the actor. */
describe.each(DIALECTS)("rotateDeployKey [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seed() {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const canvases = canvasesRepository(client);
    const owner = await users.upsert({
      providerSub: "o",
      email: "o@e.com",
      name: "Olive",
      isAdmin: false,
    });
    const editor = await users.upsert({
      providerSub: "e",
      email: "e@e.com",
      name: "Edna",
      isAdmin: false,
    });
    const canvas = await canvases.create({ ownerId: owner.id, slug: "k", apiKeyHash: "old" });
    const events: RecordAuditInput[] = [];
    const audit: AuditLog = {
      recordAudit: (e) => void events.push(e),
      flush: async () => {},
      record: () => {},
    };
    const notices: Array<{ ownerEmail: string; actor: { id: string } }> = [];
    const deps = {
      canvases,
      users,
      audit,
      notify: {
        notifyOwnerOfKeyRegen: async (i: { ownerEmail: string; actor: { id: string } }) => {
          notices.push(i);
        },
      },
    };
    const actor = (u: { id: string; email: string; name: string }, role: "owner" | "editor") => ({
      id: u.id,
      name: u.name,
      email: u.email,
      isAdmin: false,
      role,
    });
    return { canvases, users, owner, editor, canvas, events, notices, deps, actor };
  }

  it("owner rotates: new key hashed at rest, audit byRole owner, no email", async () => {
    const { canvases, canvas, owner, events, notices, deps, actor } = await seed();
    const { apiKey } = await rotateDeployKey(deps, canvas, actor(owner, "owner"));
    expect(apiKey).toMatch(/^cd_/);
    expect((await canvases.findById(canvas.id))?.apiKeyHash).toBe(hashApiKey(apiKey));
    expect(events).toEqual([
      expect.objectContaining({
        action: "key_regen",
        actorId: owner.id,
        meta: { byRole: "owner" },
      }),
    ]);
    expect(notices).toEqual([]);
  });

  it("AE19: an editor rotates: audit byRole editor and the owner is emailed naming the actor", async () => {
    const { canvas, owner, editor, events, notices, deps, actor } = await seed();
    const { apiKey } = await rotateDeployKey(deps, canvas, actor(editor, "editor"));
    expect(apiKey).toMatch(/^cd_/);
    expect(events).toEqual([
      expect.objectContaining({
        action: "key_regen",
        actorId: editor.id,
        meta: { byRole: "editor" },
      }),
    ]);
    expect(notices).toEqual([
      expect.objectContaining({
        ownerEmail: owner.email,
        actor: expect.objectContaining({ id: editor.id }),
      }),
    ]);
  });

  it("a blocked owner is not emailed (the rotation still happens)", async () => {
    const { users, canvas, owner, editor, notices, deps, actor } = await seed();
    await users.setBlocked(owner.id, true);
    await rotateDeployKey(deps, canvas, actor(editor, "editor"));
    expect(notices).toEqual([]);
  });
});

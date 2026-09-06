import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import { blobKey, canvasFileKey, screenshotKey } from "../canvas/storage-keys.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { filesRepository } from "../db/repositories/files.js";
import { kvRepository } from "../db/repositories/kv.js";
import { screenshotsRepository } from "../db/repositories/screenshots.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { LocalDriver } from "../storage/local.js";
import { memStorage } from "../storage/mem.js";
import { canvasOperationExecuteBody, canvasOperations } from "./canvas-operations.js";

const log = pino({ level: "silent" });
describe.each(DIALECTS)("admin canvas operations [%s]", (dialect) => {
  let db: DbClient;
  let directory: string | undefined;
  afterEach(async () => {
    await db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function setup() {
    db = await makeTestDb(dialect);
    const canvases = canvasesRepository(db);
    const owner = await usersRepository(db).upsert({
      providerSub: "owner",
      email: "owner@example.com",
      name: "Owner",
      isAdmin: true,
    });
    const first = await canvases.create({ ownerId: owner.id, slug: "first", apiKeyHash: "first" });
    const second = await canvases.create({
      ownerId: owner.id,
      slug: "second",
      apiKeyHash: "second",
    });
    const audit = createAuditLog(auditRepository(db), log);
    const deps = {
      canvases,
      versions: versionsRepository(db),
      drafts: draftsRepository(db),
      files: filesRepository(db),
      kv: kvRepository(db),
      screenshots: screenshotsRepository(db),
      storage: memStorage(),
      audit,
      log,
    };
    return { owner, first, second, deps, operations: canvasOperations(deps) };
  }

  it("requires confirmation and revalidates each explicit selection independently", async () => {
    const { owner, first, second, deps, operations } = await setup();
    const preview = await operations.preview("delete", [first.id, second.id]);
    const items = preview.items.map((item) => ({
      id: item.id,
      updatedAt: item.updatedAt as number,
    }));
    await expect(
      operations.execute(
        { action: "delete", items, reason: "Retired", confirmation: "DELETE" },
        owner.id,
      ),
    ).rejects.toThrow("CONFIRMATION_REQUIRED");
    expect((await deps.canvases.findById(first.id))?.status).toBe("active");
    await deps.canvases.updateSettings(second.id, { title: "Changed meanwhile" });
    const result = await operations.execute(
      { action: "delete", items, reason: "Retired", confirmation: "DELETE 2" },
      owner.id,
    );
    expect(result.outcomes).toEqual([
      { id: first.id, status: "done", message: "Completed" },
      { id: second.id, status: "changed", message: "Changed since preview. Review it again." },
    ]);
    expect((await deps.canvases.findById(second.id))?.status).toBe("active");
    await deps.audit.flush();
    expect(
      (await auditRepository(db).recent()).filter((event) => event.action === "canvas_delete"),
    ).toMatchObject([{ targetId: first.id, meta: { reason: "Retired" } }]);
    expect(
      canvasOperationExecuteBody.safeParse({
        action: "purge",
        items: [items[0], items[0]],
        reason: "why",
        confirmation: "PURGE 2",
      }).success,
    ).toBe(false);
  });

  it("permanently removes real files from disk, retains other canvases, and rejects later publication", async () => {
    const { owner, first, second, deps } = await setup();
    directory = await mkdtemp(join(tmpdir(), "canvas-admin-purge-"));
    const storage = new LocalDriver(directory);
    const operations = canvasOperations({ ...deps, storage });
    const keys = [
      blobKey(first.id, "same-hash"),
      blobKey(first.id, "draft-only"),
      canvasFileKey(first.id, "upload"),
      screenshotKey(first.id, "card"),
    ];
    for (const key of [...keys, blobKey(second.id, "same-hash")])
      await storage.put(key, new TextEncoder().encode("real bytes"));
    await deps.kv.set(first.id, "shared", "state", { value: "private" }, owner.id);
    await deps.canvases.setStatus(first.id, "deleted");
    expect((await operations.preview("purge", [first.id])).items[0]).toMatchObject({
      eligible: false,
      explanation: "Retained for 30 days after deletion",
    });
    const now = Date.now() + 31 * 86_400_000;
    const preview = await operations.preview("purge", [first.id], now);
    expect(preview.items[0]).toMatchObject({ eligible: true, resources: { kvRows: 1 } });
    const updatedAt = preview.items[0]?.updatedAt as number;
    const result = await operations.execute(
      {
        action: "purge",
        items: [{ id: first.id, updatedAt }],
        reason: "Remove old content",
        confirmation: "PURGE 1",
      },
      owner.id,
      now,
    );
    expect(result.outcomes[0]?.status).toBe("purged");
    for (const key of keys)
      await expect(readFile(join(directory, key))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(directory, blobKey(second.id, "same-hash")), "utf8")).toBe(
      "real bytes",
    );
    expect(await deps.kv.find(first.id, "shared", "state")).toBeNull();
    expect(await deps.canvases.restore(first.id)).toBe(false);
    await expect(
      deps.versions.createPending({
        canvasId: first.id,
        number: 2,
        createdBy: owner.id,
        source: "api",
      }),
    ).rejects.toThrow("permanent cleanup");
    await expect(deps.canvases.setCurrentVersion(first.id, "new-version")).rejects.toThrow(
      "unavailable",
    );
    expect((await deps.canvases.findById(first.id))?.purgedAt).toBe(now);
    await deps.audit.flush();
    expect(
      (await auditRepository(db).recent()).find((e) => e.action === "canvas_purge"),
    ).toMatchObject({ targetId: first.id, meta: { objectsDeleted: 4 } });
  });
});

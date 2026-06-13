import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../factory.js";
import { DIALECTS, makeTestDb } from "../testing.js";
import { canvasesRepository } from "./canvases.js";
import { filesRepository } from "./files.js";
import { usersRepository } from "./users.js";

describe.each(DIALECTS)("filesRepository.bytesByCanvas [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("batches per-canvas byte sums; empty list short-circuits; absent canvas omitted", async () => {
    client = await makeTestDb(dialect);
    const owner = await usersRepository(client).upsert({
      providerSub: "alice",
      email: "alice@example.com",
      name: "alice",
      isAdmin: false,
    });
    const canvases = canvasesRepository(client);
    const files = filesRepository(client);
    const c1 = await canvases.create({
      ownerId: owner.id,
      slug: "one-1111-2222",
      apiKeyHash: "h1",
    });
    const c2 = await canvases.create({
      ownerId: owner.id,
      slug: "two-1111-2222",
      apiKeyHash: "h2",
    });
    await files.insert({
      id: "f1",
      canvasId: c1.id,
      filename: "a",
      mime: "image/png",
      sizeBytes: 100,
      storageKey: "k1",
      uploadedBy: owner.id,
    });
    await files.insert({
      id: "f2",
      canvasId: c1.id,
      filename: "b",
      mime: "image/png",
      sizeBytes: 250,
      storageKey: "k2",
      uploadedBy: owner.id,
    });

    expect(await files.bytesByCanvas([])).toEqual(new Map());
    const map = await files.bytesByCanvas([c1.id, c2.id]);
    expect(map.get(c1.id)).toBe(350);
    expect(map.has(c2.id)).toBe(false); // a canvas with no files is simply absent → caller treats as 0
  });
});

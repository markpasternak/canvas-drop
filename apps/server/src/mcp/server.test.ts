import { createHash } from "node:crypto";
import { loadConfig } from "@canvas-drop/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zipSync } from "fflate";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { screenshotsRepository } from "../db/repositories/screenshots.js";
import { uploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { memStorage } from "../storage/mem.js";
import { uploadService } from "../upload/service.js";
import { buildMcpServer, type McpCaller } from "./server.js";

const silent = pino({ level: "silent" });
const config = loadConfig({});

async function seedUser(client: DbClient, email: string): Promise<string> {
  const u = await usersRepository(client).upsert({
    providerSub: email,
    email,
    name: email,
    isAdmin: false,
  });
  return u.id;
}

/** Connect a real MCP client to a tool server bound to `caller`. `screenshotsEnabled`
 *  toggles the effective preview pipeline (plan 004); the real repo always backs it. */
async function connect(
  client: DbClient,
  caller: McpCaller,
  screenshotsEnabled = false,
): Promise<Client> {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  const engine = deployEngine({ config, canvases, versions, drafts, storage, log: silent });
  const server = buildMcpServer(
    {
      config,
      users: usersRepository(client),
      canvases,
      versions,
      engine,
      upload: uploadService({
        config,
        canvases,
        users: usersRepository(client),
        uploadSessions: uploadSessionsRepository(client),
        storage,
        engine,
      }),
      storage,
      audit: createAuditLog(auditRepository(client), silent),
      screenshots: screenshotsRepository(client),
      screenshotsEnabled: () => Promise.resolve(screenshotsEnabled),
    },
    caller,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "test", version: "1" });
  await mcp.connect(clientTransport);
  return mcp;
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON text payloads
function payload(result: any): any {
  return JSON.parse(result.content[0].text);
}
// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON text payloads
function isError(result: any): boolean {
  return result.isError === true;
}

const zip = (files: Record<string, string>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])),
    ),
  ).toString("base64");

const sha = (s: string) => createHash("sha256").update(new TextEncoder().encode(s)).digest("hex");

describe.each(DIALECTS)("MCP tools [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("whoami returns the connected account", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const res = await mcp.callTool({ name: "whoami", arguments: {} });
    expect(payload(res)).toMatchObject({ id: userId, email: "owner@example.com" });
  });

  it("create_canvas then deploy_canvas succeeds in one session (AE5), no per-canvas key handled", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });

    const created = payload(
      await mcp.callTool({ name: "create_canvas", arguments: { title: "Hi" } }),
    );
    expect(created.id).toBeTruthy();
    expect(created.apiKey).toBeTruthy(); // returned once
    // Ready-to-run curl endpoints so the agent never probes for the API host, with
    // the real key embedded in the example (this is the one place the key is handed out).
    expect(created.deploy.apiBase).toContain(`/v1/canvases/${created.id}`);
    expect(created.deploy.curl).toContain(created.apiKey);
    expect(created.deploy.readback).toContain(`/v1/canvases/${created.id}/files`);

    const deployed = payload(
      await mcp.callTool({
        name: "deploy_canvas",
        arguments: { id: created.id, zipBase64: zip({ "index.html": "<h1>hi</h1>" }) },
      }),
    );
    expect(deployed.version).toBe(1);
    expect(deployed.url).toContain(created.slug);

    // The canvas is now published; get_canvas reflects it.
    const got = payload(await mcp.callTool({ name: "get_canvas", arguments: { id: created.id } }));
    expect(got.publicationState).toBe("published");
  });

  it("get_canvas_file reads back the live version — listing and content — for verification", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });

    const created = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    // No live version yet → a clear failure, not an empty success.
    const beforeDeploy = await mcp.callTool({
      name: "get_canvas_file",
      arguments: { id: created.id },
    });
    expect(isError(beforeDeploy)).toBe(true);

    await mcp.callTool({
      name: "deploy_canvas",
      arguments: {
        id: created.id,
        zipBase64: zip({ "index.html": "<h1>hello</h1>", "app.js": "console.log(1)" }),
      },
    });

    // No path → the live file listing (no blob bytes pulled into context).
    const listing = payload(
      await mcp.callTool({ name: "get_canvas_file", arguments: { id: created.id } }),
    );
    expect(listing.version).toBe(1);
    expect(listing.fileCount).toBe(2);
    expect(listing.files.map((f: { path: string }) => f.path).sort()).toEqual([
      "app.js",
      "index.html",
    ]);

    // With a path → the actual served bytes, so a deploy can be verified end-to-end.
    const file = payload(
      await mcp.callTool({
        name: "get_canvas_file",
        arguments: { id: created.id, path: "index.html" },
      }),
    );
    expect(file.encoding).toBe("utf8");
    expect(file.content).toBe("<h1>hello</h1>");
    expect(file.hash).toBe(sha("<h1>hello</h1>"));

    // A path not in the live version fails cleanly.
    const missing = await mcp.callTool({
      name: "get_canvas_file",
      arguments: { id: created.id, path: "nope.txt" },
    });
    expect(isError(missing)).toBe(true);
  });

  it("get_canvas_file returns binary files as base64 that round-trips to the bytes", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const created = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    // A minimal PNG signature — image/png → binary → base64 encoding branch.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngB64 = Buffer.from(pngBytes).toString("base64");
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: {
        id: created.id,
        files: [
          { path: "index.html", content: "<h1>x</h1>" },
          { path: "icon.png", content: pngB64, encoding: "base64" },
        ],
      },
    });

    const file = payload(
      await mcp.callTool({
        name: "get_canvas_file",
        arguments: { id: created.id, path: "icon.png" },
      }),
    );
    expect(file.encoding).toBe("base64");
    expect(file.mime).toContain("image/png");
    expect(Array.from(Buffer.from(file.content, "base64"))).toEqual(Array.from(pngBytes));
  });

  it("refuses tools against a canvas owned by another user (AE1), with no existence leak", async () => {
    client = await makeTestDb(dialect);
    const ownerA = await seedUser(client, "a@example.com");
    const ownerB = await seedUser(client, "b@example.com");
    // A creates a canvas.
    const aClient = await connect(client, { userId: ownerA });
    const made = payload(await aClient.callTool({ name: "create_canvas", arguments: {} }));

    // B tries to act on A's canvas — every canvas-scoped tool must refuse.
    const bClient = await connect(client, { userId: ownerB });
    for (const name of ["get_canvas", "list_versions", "unpublish_canvas", "get_canvas_file"]) {
      const res = await bClient.callTool({ name, arguments: { id: made.id } });
      expect(isError(res), `${name} should refuse`).toBe(true);
    }
    const deployRes = await bClient.callTool({
      name: "deploy_canvas",
      arguments: { id: made.id, zipBase64: zip({ "index.html": "x" }) },
    });
    expect(isError(deployRes)).toBe(true);

    // And B's own list never includes A's canvas.
    const bList = payload(await bClient.callTool({ name: "list_canvases", arguments: {} }));
    expect(bList.total).toBe(0);
  });

  it("list_canvases returns only the caller's canvases", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    await mcp.callTool({ name: "create_canvas", arguments: { title: "one" } });
    await mcp.callTool({ name: "create_canvas", arguments: { title: "two" } });
    const list = payload(await mcp.callTool({ name: "list_canvases", arguments: {} }));
    expect(list.total).toBe(2);
    expect(list.canvases).toHaveLength(2);
  });

  it("get_canvas / list_canvases expose hasPreview + previewUrl only when the pipeline is on (plan 004)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const off = await connect(client, { userId }); // pipeline off (default)
    const created = payload(await off.callTool({ name: "create_canvas", arguments: {} }));

    // Capture a preview for the canvas (a done screenshot job).
    const jobs = screenshotsRepository(client);
    await jobs.enqueue(created.id, "v-1");
    const claimed = await jobs.claimNext(Date.now(), Date.now() - 30_000);
    if (claimed) await jobs.markDone(claimed.id, claimed.leasedAt as number);

    // Pipeline OFF → agent sees hasPreview false and no previewUrl (parity with the
    // dashboard's pipeline-off behavior).
    const gotOff = payload(
      await off.callTool({ name: "get_canvas", arguments: { id: created.id } }),
    );
    expect(gotOff.hasPreview).toBe(false);
    expect(gotOff.previewUrl).toBeUndefined();

    // Pipeline ON → hasPreview true + a card previewUrl on both get_canvas and the list.
    const on = await connect(client, { userId }, true);
    const gotOn = payload(await on.callTool({ name: "get_canvas", arguments: { id: created.id } }));
    expect(gotOn.hasPreview).toBe(true);
    expect(gotOn.previewUrl).toContain("__canvasdrop_preview?rendition=card");

    const list = payload(await on.callTool({ name: "list_canvases", arguments: {} }));
    const listed = list.canvases.find((c: { id: string }) => c.id === created.id);
    expect(listed?.hasPreview).toBe(true);
    expect(listed?.previewUrl).toContain("__canvasdrop_preview?rendition=card");
  });

  it("rollback then re-points the live version; unpublish returns it to draft", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const made = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: made.id, zipBase64: zip({ "index.html": "v1" }) },
    });
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: made.id, zipBase64: zip({ "index.html": "v2" }) },
    });
    const rolled = payload(
      await mcp.callTool({ name: "rollback_canvas", arguments: { id: made.id, version: 1 } }),
    );
    expect(rolled.version).toBe(1);

    const unpub = payload(
      await mcp.callTool({ name: "unpublish_canvas", arguments: { id: made.id } }),
    );
    expect(unpub.publicationState).toBe("draft");
  });

  it("surfaces a typed error (not a crash) for an invalid deploy body", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const made = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    const res = await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: made.id, zipBase64: Buffer.from("not a zip").toString("base64") },
    });
    expect(isError(res)).toBe(true);
  });

  it("deploy_canvas accepts an inline files array (one-call publish)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const made = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    const deployed = payload(
      await mcp.callTool({
        name: "deploy_canvas",
        arguments: { id: made.id, files: [{ path: "index.html", content: "<h1>hi</h1>" }] },
      }),
    );
    expect(deployed.version).toBe(1);
    const got = payload(await mcp.callTool({ name: "get_canvas", arguments: { id: made.id } }));
    expect(got.publicationState).toBe("published");
  });

  it("deploy_canvas rejects both files+zipBase64 and neither", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const made = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    const both = await mcp.callTool({
      name: "deploy_canvas",
      arguments: {
        id: made.id,
        zipBase64: zip({ "index.html": "x" }),
        files: [{ path: "a", content: "b" }],
      },
    });
    expect(isError(both)).toBe(true);
    const neither = await mcp.callTool({ name: "deploy_canvas", arguments: { id: made.id } });
    expect(isError(neither)).toBe(true);
  });

  it("begin_deploy → add_files → finalize_deploy publishes (chunked, text as utf8)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const made = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    const files = { "index.html": "<h1>x</h1>", "app.js": "console.log(1)" };
    const begun = payload(
      await mcp.callTool({
        name: "begin_deploy",
        arguments: {
          id: made.id,
          manifest: Object.entries(files).map(([path, content]) => ({
            path,
            hash: sha(content),
            size: new TextEncoder().encode(content).byteLength,
          })),
        },
      }),
    );
    expect(begun.uploadId).toBeTruthy();
    expect(begun.missingHashes).toHaveLength(2);

    // Chunk the upload across two add_files calls.
    await mcp.callTool({
      name: "add_files",
      arguments: {
        id: made.id,
        uploadId: begun.uploadId,
        files: [{ path: "index.html", content: files["index.html"] }],
      },
    });
    await mcp.callTool({
      name: "add_files",
      arguments: {
        id: made.id,
        uploadId: begun.uploadId,
        files: [{ path: "app.js", content: files["app.js"] }],
      },
    });

    const result = payload(
      await mcp.callTool({
        name: "finalize_deploy",
        arguments: { id: made.id, uploadId: begun.uploadId },
      }),
    );
    expect(result.version).toBe(1);
    expect(result.fileCount).toBe(2);
  });

  it("the new upload tools refuse a canvas owned by another user", async () => {
    client = await makeTestDb(dialect);
    const ownerA = await seedUser(client, "a@example.com");
    const ownerB = await seedUser(client, "b@example.com");
    const aClient = await connect(client, { userId: ownerA });
    const made = payload(await aClient.callTool({ name: "create_canvas", arguments: {} }));
    const bClient = await connect(client, { userId: ownerB });
    const begin = await bClient.callTool({
      name: "begin_deploy",
      arguments: { id: made.id, manifest: [{ path: "index.html", hash: sha("x"), size: 1 }] },
    });
    expect(isError(begin)).toBe(true);
  });
});

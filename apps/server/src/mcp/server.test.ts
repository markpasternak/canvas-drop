import { createHash } from "node:crypto";
import { loadConfig } from "@canvas-drop/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zipSync } from "fflate";
import { pino } from "pino";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import { cloneService } from "../canvas/clone-service.js";
import type { DbClient } from "../db/factory.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { filesRepository } from "../db/repositories/files.js";
import { screenshotsRepository } from "../db/repositories/screenshots.js";
import { uploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { draftService } from "../draft/service.js";
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
  const draftsRepo = draftsRepository(client);
  const storage = memStorage();
  const audit = createAuditLog(auditRepository(client), silent);
  const engine = deployEngine({
    config,
    canvases,
    versions,
    drafts: draftsRepo,
    storage,
    log: silent,
  });
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
      clone: cloneService({ canvases, versions, drafts: draftsRepo, storage }),
      drafts: draftService({
        config,
        canvases,
        versions,
        drafts: draftsRepo,
        storage,
        audit,
        log: silent,
      }),
      usage: usageEventsRepository(client),
      files: filesRepository(client),
      aiUsage: aiUsageRepository(client),
      audit,
      log: silent,
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
// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON text payloads
function text(result: any): string {
  return result.content[0].text;
}

const zip = (files: Record<string, string>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])),
    ),
  ).toString("base64");

const sha = (s: string) => createHash("sha256").update(new TextEncoder().encode(s)).digest("hex");

/** A small valid PNG, base64-encoded, for the set_canvas_preview tests. */
async function pngBase64(): Promise<string> {
  const buf = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return buf.toString("base64");
}

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

  it("update_canvas restricting a public_link canvas returns a CDN edge-cache warning (parity)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const created = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: created.id, zipBase64: zip({ "index.html": "<h1>hi</h1>" }) },
    });
    // Seed the anonymously-public state directly (public_link is admin-gated), then
    // exercise the downgrade through the MCP tool — the warning must reach the agent.
    await canvasesRepository(client).updateSettings(created.id, { access: "public_link" });
    const restricted = payload(
      await mcp.callTool({
        name: "update_canvas",
        arguments: { id: created.id, access: "private" },
      }),
    );
    expect(restricted.warning).toMatch(/CDN/);
  });

  it("update_canvas sets the unified tags under the owner check and refreshes searchText (U4)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const created = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    const updated = payload(
      await mcp.callTool({
        name: "update_canvas",
        arguments: { id: created.id, tags: ["Alpha", "beta"] },
      }),
    );
    // The owner-facing tags round-trip through update_canvas (agent-native parity).
    expect(updated.tags).toEqual(["Alpha", "beta"]);

    // The tag write recomputes the forgiving-search blob (integration with U2): the
    // owner-list query finds the canvas by a tag substring it had no other source for.
    const found = await canvasesRepository(client).listByOwnerFiltered({
      ownerId: userId,
      q: "alph",
      limit: 50,
      offset: 0,
    });
    expect(found.items.map((c) => c.id)).toContain(created.id);
  });

  it("update_canvas sets the unified description under the owner check and refreshes searchText (U21)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const created = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    const updated = payload(
      await mcp.callTool({
        name: "update_canvas",
        arguments: { id: created.id, description: "Quarterly pipeline forecast" },
      }),
    );
    // The unified description round-trips through update_canvas (agent-native parity, U21).
    expect(updated.description).toBe("Quarterly pipeline forecast");

    // The description write recomputes the forgiving-search blob (integration with U2):
    // the owner-list query finds the canvas by a description substring.
    const found = await canvasesRepository(client).listByOwnerFiltered({
      ownerId: userId,
      q: "pipeline",
      limit: 50,
      offset: 0,
    });
    expect(found.items.map((c) => c.id)).toContain(created.id);
  });

  it("update_canvas tags on a non-owned canvas reads as not-found (requireOwned)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedUser(client, "owner@example.com");
    const otherId = await seedUser(client, "other@example.com");
    // Owner creates the canvas; a different account connects and tries to tag it.
    const ownerMcp = await connect(client, { userId: ownerId });
    const created = payload(await ownerMcp.callTool({ name: "create_canvas", arguments: {} }));

    const otherMcp = await connect(client, { userId: otherId });
    expect(
      isError(
        await otherMcp.callTool({
          name: "update_canvas",
          arguments: { id: created.id, tags: ["x"] },
        }),
      ),
    ).toBe(true);
    // The owner's tags were never touched by the non-owner's call.
    const cv = await canvasesRepository(client).findById(created.id);
    expect(cv?.tags ?? []).toEqual([]);
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

  it("create_canvas honors a custom slug, and rejects an invalid or taken one", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });

    const made = payload(
      await mcp.callTool({ name: "create_canvas", arguments: { slug: "my-cool-canvas" } }),
    );
    expect(made.slug).toBe("my-cool-canvas");

    // A reserved word is rejected.
    expect(isError(await mcp.callTool({ name: "create_canvas", arguments: { slug: "api" } }))).toBe(
      true,
    );
    // A taken slug is rejected.
    expect(
      isError(await mcp.callTool({ name: "create_canvas", arguments: { slug: "my-cool-canvas" } })),
    ).toBe(true);
  });

  it("set_capabilities toggles backend + features (mirrors the Backend tab)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    const updated = payload(
      await mcp.callTool({
        name: "set_capabilities",
        arguments: { id: cv.id, backendEnabled: true, kv: true, ai: false },
      }),
    );
    expect(updated.id).toBe(cv.id);
    // No-op call (no fields) returns the canvas without error.
    expect(
      isError(await mcp.callTool({ name: "set_capabilities", arguments: { id: cv.id } })),
    ).toBe(false);
  });

  it("set_canvas_slug changes the URL; the old slug frees up, a taken slug is rejected", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: { slug: "first" } }));

    const renamed = payload(
      await mcp.callTool({ name: "set_canvas_slug", arguments: { id: cv.id, slug: "second" } }),
    );
    expect(renamed.slug).toBe("second");
    expect(renamed.deploy.apiBase).toContain(cv.id);

    // A second canvas can now take the freed-up "first" slug.
    const other = payload(
      await mcp.callTool({ name: "create_canvas", arguments: { slug: "first" } }),
    );
    // …and the first canvas can't rename onto the now-taken "first".
    expect(
      isError(
        await mcp.callTool({ name: "set_canvas_slug", arguments: { id: cv.id, slug: "first" } }),
      ),
    ).toBe(true);
    expect(other.slug).toBe("first");
  });

  it("regenerate_deploy_key mints a new key + refreshed deploy block", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    const out = payload(
      await mcp.callTool({ name: "regenerate_deploy_key", arguments: { id: cv.id } }),
    );
    expect(out.apiKey).toMatch(/^cd_/);
    expect(out.apiKey).not.toBe(cv.apiKey);
    expect(out.deploy.curl).toContain(out.apiKey);
  });

  it("archive → unarchive → delete lifecycle (mirrors the dashboard buttons)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    const archived = payload(
      await mcp.callTool({ name: "archive_canvas", arguments: { id: cv.id } }),
    );
    expect(archived.status).toBe("archived");
    // Unarchiving a non-archived canvas would fail; this one is archived → ok.
    const active = payload(
      await mcp.callTool({ name: "unarchive_canvas", arguments: { id: cv.id } }),
    );
    expect(active.status).toBe("active");
    // Unarchive again → NOT_ARCHIVED failure.
    expect(
      isError(await mcp.callTool({ name: "unarchive_canvas", arguments: { id: cv.id } })),
    ).toBe(true);

    // Delete → the canvas reads as not found afterwards (soft-deleted, owner loses it).
    expect(isError(await mcp.callTool({ name: "delete_canvas", arguments: { id: cv.id } }))).toBe(
      false,
    );
    expect(isError(await mcp.callTool({ name: "get_canvas", arguments: { id: cv.id } }))).toBe(
      true,
    );
  });

  it("update_canvas renames + enforces share/gallery preconditions", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    // Rename works on an unpublished canvas.
    const renamed = payload(
      await mcp.callTool({ name: "update_canvas", arguments: { id: cv.id, title: "Renamed" } }),
    );
    expect(renamed.title).toBe("Renamed");

    // Sharing an unpublished canvas is refused (SHARE_REQUIRES_PUBLISH).
    expect(
      isError(
        await mcp.callTool({
          name: "update_canvas",
          arguments: { id: cv.id, access: "whole_org" },
        }),
      ),
    ).toBe(true);

    // Publish, then sharing succeeds.
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: cv.id, zipBase64: zip({ "index.html": "<h1>x</h1>" }) },
    });
    const shared = payload(
      await mcp.callTool({ name: "update_canvas", arguments: { id: cv.id, access: "whole_org" } }),
    );
    expect(shared.id).toBe(cv.id);

    // public_link is admin-gated per account; a seeded non-admin owner is refused.
    expect(
      isError(
        await mcp.callTool({
          name: "update_canvas",
          arguments: { id: cv.id, access: "public_link" },
        }),
      ),
    ).toBe(true);

    // Listing in the gallery while password-protected is refused.
    expect(
      isError(
        await mcp.callTool({
          name: "update_canvas",
          arguments: { id: cv.id, password: "secret", galleryListed: true },
        }),
      ),
    ).toBe(true);
  });

  it("draft loop: write → get_draft (dirty) → publish → read back live (editor parity)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    // Write a draft file, then the draft is dirty and lists it.
    await mcp.callTool({
      name: "write_draft_file",
      arguments: { id: cv.id, path: "index.html", content: "<h1>draft</h1>" },
    });
    const draft = payload(await mcp.callTool({ name: "get_draft", arguments: { id: cv.id } }));
    expect(draft.dirty).toBe(true);
    expect(draft.files.map((f: { path: string }) => f.path)).toContain("index.html");

    // Read the draft file back.
    const df = payload(
      await mcp.callTool({ name: "read_draft_file", arguments: { id: cv.id, path: "index.html" } }),
    );
    expect(df.content).toBe("<h1>draft</h1>");

    // create=true refuses to overwrite an existing path.
    expect(
      isError(
        await mcp.callTool({
          name: "write_draft_file",
          arguments: { id: cv.id, path: "index.html", content: "x", create: true },
        }),
      ),
    ).toBe(true);

    // rename then delete reshape the draft file list.
    await mcp.callTool({
      name: "rename_draft_file",
      arguments: { id: cv.id, from: "index.html", to: "main.html" },
    });
    let view = payload(await mcp.callTool({ name: "get_draft", arguments: { id: cv.id } }));
    expect(view.files.map((f: { path: string }) => f.path)).toEqual(["main.html"]);
    await mcp.callTool({ name: "delete_draft_file", arguments: { id: cv.id, path: "main.html" } });
    view = payload(await mcp.callTool({ name: "get_draft", arguments: { id: cv.id } }));
    expect(view.files).toHaveLength(0);

    // Put index.html back and publish → a live version exists, and get_canvas_file serves it.
    await mcp.callTool({
      name: "write_draft_file",
      arguments: { id: cv.id, path: "index.html", content: "<h1>draft</h1>" },
    });
    const pub = payload(await mcp.callTool({ name: "publish_draft", arguments: { id: cv.id } }));
    expect(pub.version).toBe(1);
    const live = payload(
      await mcp.callTool({ name: "get_canvas_file", arguments: { id: cv.id, path: "index.html" } }),
    );
    expect(live.content).toBe("<h1>draft</h1>");

    // Edit the draft, then restore_draft to v1 → the draft reverts to the published files.
    await mcp.callTool({
      name: "write_draft_file",
      arguments: { id: cv.id, path: "extra.html", content: "<p>extra</p>" },
    });
    const restored = payload(
      await mcp.callTool({ name: "restore_draft", arguments: { id: cv.id, version: 1 } }),
    );
    expect(restored.files.map((f: { path: string }) => f.path)).toEqual(["index.html"]);
    // Restoring a non-existent version fails cleanly.
    expect(
      isError(await mcp.callTool({ name: "restore_draft", arguments: { id: cv.id, version: 99 } })),
    ).toBe(true);
  });

  it("get_canvas_usage returns view + op stats for a canvas you own", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    const usage = payload(
      await mcp.callTool({ name: "get_canvas_usage", arguments: { id: cv.id } }),
    );
    expect(usage).toMatchObject({ totalViews: 0, kvOps: 0, fileCount: 0, aiCalls: 0 });
    expect(Array.isArray(usage.viewsByDay)).toBe(true);
  });

  it("clone_canvas copies an owned canvas into a fresh unpublished canvas", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const src = payload(await mcp.callTool({ name: "create_canvas", arguments: { title: "Src" } }));
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: src.id, zipBase64: zip({ "index.html": "<h1>src</h1>" }) },
    });

    const clone = payload(await mcp.callTool({ name: "clone_canvas", arguments: { id: src.id } }));
    expect(clone.id).not.toBe(src.id);
    expect(clone.slug).not.toBe(src.slug);
    // The clone is owned by the caller and starts unpublished (draft).
    const got = payload(await mcp.callTool({ name: "get_canvas", arguments: { id: clone.id } }));
    expect(got.publicationState).not.toBe("published");
  });

  it("grant_access adds an org member to the allowlist; list/revoke reflect it", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner@example.com");
    await seedUser(client, "teammate@example.com"); // an org member
    const mcp = await connect(client, { userId: owner });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    const granted = payload(
      await mcp.callTool({
        name: "grant_access",
        arguments: { id: cv.id, email: "teammate@example.com" },
      }),
    );
    expect(granted).toMatchObject({ ok: true, kind: "member" });

    const access = payload(await mcp.callTool({ name: "list_access", arguments: { id: cv.id } }));
    expect(access.entries).toHaveLength(1);
    expect(access.entries[0]).toMatchObject({ kind: "member", email: "teammate@example.com" });

    const ok = payload(
      await mcp.callTool({
        name: "revoke_access",
        arguments: { id: cv.id, entryId: access.entries[0].id },
      }),
    );
    expect(ok.ok).toBe(true);
    const after = payload(await mcp.callTool({ name: "list_access", arguments: { id: cv.id } }));
    expect(after.entries).toHaveLength(0);

    // A non-member email routes to the guest-invite path, which is unavailable in the
    // test harness (no GuestService/mailer wired) → GUESTS_UNAVAILABLE, mirroring proxy mode.
    const guest = await mcp.callTool({
      name: "grant_access",
      arguments: { id: cv.id, email: "outsider@example.com" },
    });
    expect(isError(guest)).toBe(true);
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
    for (const name of [
      "get_canvas",
      "list_versions",
      "unpublish_canvas",
      "rollback_canvas",
      "get_canvas_file",
      "update_canvas",
      "set_canvas_preview",
      "set_capabilities",
      "set_canvas_slug",
      "regenerate_deploy_key",
      "archive_canvas",
      "unarchive_canvas",
      "delete_canvas",
      "list_access",
      "resend_guest_invite",
      "revoke_access",
      "get_canvas_usage",
      "get_draft",
      "read_draft_file",
      "write_draft_file",
      "delete_draft_file",
      "rename_draft_file",
      "publish_draft",
      "restore_draft",
    ]) {
      const res = await bClient.callTool({ name, arguments: { id: made.id } });
      expect(isError(res), `${name} should refuse`).toBe(true);
    }
    // grant_access / clone_canvas are owner-scoped too (clone of a non-owned, non-template
    // source reads as not found).
    expect(
      isError(
        await bClient.callTool({
          name: "grant_access",
          arguments: { id: made.id, email: "x@example.com" },
        }),
      ),
    ).toBe(true);
    expect(
      isError(await bClient.callTool({ name: "clone_canvas", arguments: { id: made.id } })),
    ).toBe(true);
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

  it("list_canvases query inherits the forgiving search (matches a tag, case/accent-insensitive)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const tagged = payload(
      await mcp.callTool({ name: "create_canvas", arguments: { title: "Café Report" } }),
    );
    await mcp.callTool({ name: "create_canvas", arguments: { title: "Unrelated" } });
    await mcp.callTool({
      name: "update_canvas",
      arguments: { id: tagged.id, tags: ["finance"] },
    });

    // Tag substring (not in title/slug) — proves the search blob, not just title/slug.
    const byTag = payload(
      await mcp.callTool({ name: "list_canvases", arguments: { query: "finance" } }),
    );
    expect(byTag.total).toBe(1);
    // biome-ignore lint/suspicious/noExplicitAny: test payload is untyped JSON
    expect(byTag.canvases.map((cv: any) => cv.id)).toEqual([tagged.id]);

    // Case + accent forgiving on the title.
    const byTitle = payload(
      await mcp.callTool({ name: "list_canvases", arguments: { query: "CAFE" } }),
    );
    expect(byTitle.total).toBe(1);
  });

  it("list_canvases sort=popular ranks by recent views and reports view rollups (plan 004)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const hot = payload(await mcp.callTool({ name: "create_canvas", arguments: { title: "hot" } }));
    const cold = payload(
      await mcp.callTool({ name: "create_canvas", arguments: { title: "cold" } }),
    );
    const usage = usageEventsRepository(client);
    const now = Date.now();
    // hot: two distinct recent viewers (guest ids have no FK on userId); cold: none.
    await usage.recordView({ canvasId: hot.id, userId, windowMs: 60_000, now });
    await usage.recordView({ canvasId: hot.id, userId: "guest:y", windowMs: 60_000, now: now + 1 });

    const list = payload(
      await mcp.callTool({ name: "list_canvases", arguments: { sort: "popular" } }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: test payload is untyped JSON
    expect(list.canvases.map((cv: any) => cv.id)).toEqual([hot.id, cold.id]);
    // biome-ignore lint/suspicious/noExplicitAny: test payload is untyped JSON
    const hotRow = list.canvases.find((cv: any) => cv.id === hot.id);
    expect(hotRow.recentViews).toBe(2);
    expect(hotRow.viewCount).toBe(2); // lifetime rollup bumped by the counted views
    expect(hotRow.lastViewedAt).toBe(now + 1);
    // biome-ignore lint/suspicious/noExplicitAny: test payload is untyped JSON
    expect(list.canvases.find((cv: any) => cv.id === cold.id).recentViews).toBe(0);
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

  it("set_canvas_preview uploads a custom cover, clears it back to auto, and rejects garbage", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const made = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    // (1) A valid base64 image becomes the cover and pins previewMode to 'custom'.
    const set = payload(
      await mcp.callTool({
        name: "set_canvas_preview",
        arguments: { id: made.id, image: await pngBase64() },
      }),
    );
    expect(set.previewMode).toBe("custom");

    // (2) Clearing from custom reverts to auto (the orphaned renditions are dropped).
    const cleared = payload(
      await mcp.callTool({ name: "set_canvas_preview", arguments: { id: made.id } }),
    );
    expect(cleared.previewMode).toBe("auto");

    // (3) Clearing again (already auto) is a no-op — never deletes an auto screenshot.
    const noop = payload(
      await mcp.callTool({ name: "set_canvas_preview", arguments: { id: made.id } }),
    );
    expect(noop.previewMode).toBe("auto");

    // (4) Garbage that decodes to non-empty bytes but isn't an image → isError.
    const bad = await mcp.callTool({
      name: "set_canvas_preview",
      arguments: { id: made.id, image: Buffer.from("not an image").toString("base64") },
    });
    expect(isError(bad)).toBe(true);
  });

  it("update_canvas response reflects a changed access (read-your-writes)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const made = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    expect(made.access).toBe("private");
    // Sharing above private requires a published version first (else SHARE_REQUIRES_PUBLISH).
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: made.id, zipBase64: zip({ "index.html": "<h1>x</h1>" }) },
    });
    const updated = payload(
      await mcp.callTool({
        name: "update_canvas",
        arguments: { id: made.id, access: "whole_org" },
      }),
    );
    expect(updated.access).toBe("whole_org");
  });

  it("deploy/begin_deploy/rollback refuse an archived canvas with NOT_ACTIVE", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const made = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    // Publish twice so a rollback target exists, then archive.
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: made.id, zipBase64: zip({ "index.html": "v1" }) },
    });
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: made.id, zipBase64: zip({ "index.html": "v2" }) },
    });
    await mcp.callTool({ name: "archive_canvas", arguments: { id: made.id } });

    const deployRes = await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: made.id, zipBase64: zip({ "index.html": "v3" }) },
    });
    expect(isError(deployRes)).toBe(true);
    expect(text(deployRes)).toContain("NOT_ACTIVE");

    const beginRes = await mcp.callTool({
      name: "begin_deploy",
      arguments: { id: made.id, manifest: [{ path: "index.html", hash: sha("v3"), size: 2 }] },
    });
    expect(isError(beginRes)).toBe(true);
    expect(text(beginRes)).toContain("NOT_ACTIVE");

    const rollbackRes = await mcp.callTool({
      name: "rollback_canvas",
      arguments: { id: made.id, version: 1 },
    });
    expect(isError(rollbackRes)).toBe(true);
    expect(text(rollbackRes)).toContain("NOT_ACTIVE");
  });

  it("finalize_deploy refuses an archived canvas with NOT_ACTIVE", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const made = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    // Open + stage an upload while the canvas is still active...
    const begun = payload(
      await mcp.callTool({
        name: "begin_deploy",
        arguments: { id: made.id, manifest: [{ path: "index.html", hash: sha("v1"), size: 2 }] },
      }),
    );
    await mcp.callTool({
      name: "add_files",
      arguments: {
        id: made.id,
        uploadId: begun.uploadId,
        files: [{ path: "index.html", content: "v1" }],
      },
    });
    // ...then archive before finalizing: the publish must be refused, mirroring begin_deploy.
    await mcp.callTool({ name: "archive_canvas", arguments: { id: made.id } });
    const finalizeRes = await mcp.callTool({
      name: "finalize_deploy",
      arguments: { id: made.id, uploadId: begun.uploadId },
    });
    expect(isError(finalizeRes)).toBe(true);
    expect(text(finalizeRes)).toContain("NOT_ACTIVE");
  });
});

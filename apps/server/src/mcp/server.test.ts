import { createHash } from "node:crypto";
import { loadConfig } from "@canvas-drop/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zipSync } from "fflate";
import { pino } from "pino";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
import { devStrategy } from "../auth/dev.js";
import { sessionService } from "../auth/session.js";
import { cloneService } from "../canvas/clone-service.js";
import { versionHistoryService } from "../canvas/version-history.js";
import { createSecretCipher } from "../connections/secret-cipher.js";
import { connectionService } from "../connections/service.js";
import type { DbClient } from "../db/factory.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { connectionsRepository } from "../db/repositories/connections.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { filesRepository } from "../db/repositories/files.js";
import { invitationsRepository } from "../db/repositories/invitations.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { screenshotsRepository } from "../db/repositories/screenshots.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { uploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { draftService } from "../draft/service.js";
import { makeInviteService } from "../invites/testing.js";
import { memStorage } from "../storage/mem.js";
import { teamsService } from "../teams/service.js";
import { uploadService } from "../upload/service.js";
import { buildMcpServer } from "./server.js";
import { type CanvasToolName, checkToolInventory, TOOL_MIN_ROLE } from "./tool-roles.js";

const silent = pino({ level: "silent" });
const config = loadConfig({});
const domainConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
});

/** Build the real management-list route for MCP parity assertions. */
function managementApp(client: DbClient, cfg: ReturnType<typeof loadConfig>) {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const drafts = draftsRepository(client);
  const storage = memStorage();
  return buildApp({
    config: cfg,
    db: client,
    rootLogger: silent,
    strategy: devStrategy(cfg),
    users: usersRepository(client),
    canvases,
    versions,
    drafts,
    storage,
    engine: deployEngine({ config: cfg, canvases, versions, drafts, storage, log: silent }),
    audit: createAuditLog(auditRepository(client), silent),
    sessionSvc: sessionService(cfg, sessionsRepository(client)),
    peerIp: () => "127.0.0.1",
  });
}

async function seedUser(client: DbClient, email: string, isAdmin = false): Promise<string> {
  const u = await usersRepository(client).upsert({
    providerSub: email,
    email,
    name: email,
    isAdmin,
  });
  return u.id;
}

/** Connect a real MCP client to a tool server bound to `caller`. `screenshotsEnabled`
 *  toggles the effective preview pipeline (plan 004); the real repo always backs it. */
async function connect(
  client: DbClient,
  caller: { userId: string; isAdmin?: boolean; orgIds?: Set<string>; tenancyActive?: boolean },
  screenshotsEnabled = false,
  // Config the MCP server runs under. Defaults to the org-less config; team-grant tests
  // pass a tenancy config so `update_canvas access=team` sees tenancy active (the guard
  // reads config.org.name, not the caller flag).
  cfg = config,
  // Blob store. Defaults to a fresh in-memory store; cross-connection tests (e.g. a
  // teammate cloning the owner's deployed canvas) pass ONE shared store so the source
  // blobs the clone copies are visible to the second connection.
  storage = memStorage(),
): Promise<Client> {
  const canvases = canvasesRepository(client);
  const versions = versionsRepository(client);
  const draftsRepo = draftsRepository(client);
  const audit = createAuditLog(auditRepository(client), silent);
  const connections = connectionService({
    repository: connectionsRepository(client),
    canvases,
    cipher: createSecretCipher(cfg.connections.encryptionKey),
    audit,
  });
  const teams = teamsRepository(client);
  const orgMembers = orgMembersRepository(client);
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
      config: cfg,
      users: usersRepository(client),
      orgs: orgsRepository(client),
      orgMembers,
      teams,
      teamsService: teamsService({
        teams,
        orgMembers,
        users: usersRepository(client),
        invites: makeInviteService(client, cfg),
        invitations: invitationsRepository(client),
        audit,
      }),
      invites: makeInviteService(client, cfg),
      invitations: invitationsRepository(client),
      canvases,
      versions,
      engine,
      versionHistory: versionHistoryService({ versions, storage, engine, audit }),
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
        users: usersRepository(client),
      }),
      usage: usageEventsRepository(client),
      files: filesRepository(client),
      aiUsage: aiUsageRepository(client),
      connections,
      audit,
      log: silent,
      screenshots: screenshotsRepository(client),
      screenshotsEnabled: () => Promise.resolve(screenshotsEnabled),
    },
    {
      userId: caller.userId,
      isAdmin: caller.isAdmin ?? false,
      orgIds: caller.orgIds ?? new Set<string>(),
      tenancyActive: caller.tenancyActive ?? false,
    },
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

  it("list_canvas_connections mirrors the sanitized manager projection", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const canvas = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    const repository = connectionsRepository(client);
    await repository.create({
      id: "profile-1",
      key: "market",
      label: "Market data",
      origin: "https://stocks.example.com",
      allowedMethods: ["GET"],
      protectedHeaderNames: ["authorization"],
      protectedHeadersEnvelope: "opaque-ciphertext",
      enabled: true,
      createdBy: userId,
      createdAt: 1,
      updatedAt: 1,
    });
    await repository.attach({
      canvasId: canvas.id,
      connectionId: "profile-1",
      createdBy: userId,
      createdAt: 1,
    });

    const result = await mcp.callTool({
      name: "list_canvas_connections",
      arguments: { id: canvas.id },
    });
    const serialized = JSON.stringify(payload(result));
    expect(serialized).toContain("stocks.example.com");
    expect(serialized).toContain("encryption_key_unavailable");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("opaque-ciphertext");
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
    // Audience rides alongside lifecycle (restricted access model): a fresh canvas is Restricted.
    expect(got.access).toBe("private");
    expect(got.accessMode).toBe("restricted");
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
    // Seed the anonymously-public state directly, then
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
    // Review #10: the mutation's echo carries the same identity as get_canvas.
    expect(updated.role).toBe("owner");
    expect(updated.owner).toMatchObject({ id: userId, email: "owner@example.com" });

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
        arguments: { id: cv.id, backendEnabled: true, kv: true, ai: false, authoring: true },
      }),
    );
    expect(updated.id).toBe(cv.id);
    // Parity: an agent can flip `authoring` (default-off) over MCP just like the Backend tab.
    expect((await canvasesRepository(client).findById(cv.id))?.capAuthoring).toBe(true);
    // No-op call (no fields) returns the canvas without error.
    expect(
      isError(await mcp.callTool({ name: "set_capabilities", arguments: { id: cv.id } })),
    ).toBe(false);
  });

  it("a disabled canvas is read-only over MCP: mutations reject DISABLED, reads still work", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: { slug: "disme" } }));
    await canvasesRepository(client).setDisabled(cv.id, "policy violation");

    // Every owner-mutation tool rejects with the shared DISABLED contract (incl. reason).
    const mutations: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "update_canvas", args: { id: cv.id, title: "new" } },
      { name: "set_capabilities", args: { id: cv.id, kv: false } },
      { name: "set_canvas_slug", args: { id: cv.id, slug: "renamed" } },
      { name: "set_canvas_preview", args: { id: cv.id } },
      { name: "regenerate_deploy_key", args: { id: cv.id } },
      { name: "grant_access", args: { id: cv.id, email: "guest@example.com" } },
      { name: "archive_canvas", args: { id: cv.id } },
      { name: "unarchive_canvas", args: { id: cv.id } },
      { name: "unpublish_canvas", args: { id: cv.id } },
      { name: "delete_canvas", args: { id: cv.id } },
      {
        name: "deploy_canvas",
        args: { id: cv.id, zipBase64: zip({ "index.html": "<h1>x</h1>" }) },
      },
      // Staged-upload + rollback lifecycle mutations also go through requireMutable, so the
      // DISABLED gate fires before any uploadId/version is consulted (dummy values are fine).
      {
        name: "begin_deploy",
        args: { id: cv.id, manifest: [{ path: "index.html", hash: sha("x"), size: 1 }] },
      },
      {
        name: "add_files",
        args: { id: cv.id, uploadId: "nope", files: [{ path: "index.html", content: "x" }] },
      },
      { name: "finalize_deploy", args: { id: cv.id, uploadId: "nope" } },
      { name: "rollback_canvas", args: { id: cv.id, version: 1 } },
      { name: "delete_version", args: { id: cv.id, version: 1 } },
      // Draft EDIT tools share the same gate.
      { name: "write_draft_file", args: { id: cv.id, path: "a.html", content: "x" } },
      { name: "delete_draft_file", args: { id: cv.id, path: "a.html" } },
      { name: "rename_draft_file", args: { id: cv.id, from: "a.html", to: "b.html" } },
      { name: "restore_draft", args: { id: cv.id, version: 1 } },
      { name: "publish_draft", args: { id: cv.id } },
    ];
    for (const m of mutations) {
      const res = await mcp.callTool({ name: m.name, arguments: m.args });
      expect(isError(res), m.name).toBe(true);
      expect(text(res), m.name).toContain("DISABLED");
      expect(text(res), m.name).toContain("policy violation"); // the reason is surfaced
    }
    // The canvas was never mutated.
    expect((await canvasesRepository(client).findById(cv.id))?.status).toBe("disabled");

    // Reads still succeed.
    expect(isError(await mcp.callTool({ name: "get_canvas", arguments: { id: cv.id } }))).toBe(
      false,
    );
    expect(isError(await mcp.callTool({ name: "list_versions", arguments: { id: cv.id } }))).toBe(
      false,
    );
    expect(isError(await mcp.callTool({ name: "list_access", arguments: { id: cv.id } }))).toBe(
      false,
    );
    expect(isError(await mcp.callTool({ name: "get_draft", arguments: { id: cv.id } }))).toBe(
      false,
    );
  });

  it("a NON-OWNER mutating a DISABLED canvas reads as not-found, NEVER DISABLED (ownership before state)", async () => {
    // Locks the gate ordering: requireMutable checks OWNERSHIP first, so a non-owner of a
    // disabled canvas gets the opaque not-found (no existence leak, §12.0) — surfacing the
    // DISABLED 409 would reveal the row exists. The MCP surface is per-account (no admin
    // path), so a non-owner admin is just another non-owner here.
    client = await makeTestDb(dialect);
    const ownerId = await seedUser(client, "owner@example.com");
    const otherId = await seedUser(client, "other@example.com");
    const ownerMcp = await connect(client, { userId: ownerId });
    const cv = payload(await ownerMcp.callTool({ name: "create_canvas", arguments: {} }));
    await canvasesRepository(client).setDisabled(cv.id, "policy violation");

    const otherMcp = await connect(client, { userId: otherId });
    const res = await otherMcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, title: "hijacked" },
    });
    expect(isError(res)).toBe(true);
    expect(text(res)).toContain("not found");
    // The non-owner must NOT see the disabled state or its reason.
    expect(text(res)).not.toContain("DISABLED");
    expect(text(res)).not.toContain("policy violation");
    // The canvas was never touched.
    const after = await canvasesRepository(client).findById(cv.id);
    expect(after?.title).toBe("");
    expect(after?.status).toBe("disabled");
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
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: cv.id, zipBase64: zip({ "index.html": "<h1>x</h1>" }) },
    });
    const listed = payload(
      await mcp.callTool({
        name: "update_canvas",
        arguments: {
          id: cv.id,
          access: "whole_org",
          discoverability: "listed",
          galleryListed: true,
          galleryTemplatable: true,
        },
      }),
    );
    expect(listed.currentVersionId).toBeTruthy();

    const archived = payload(
      await mcp.callTool({ name: "archive_canvas", arguments: { id: cv.id } }),
    );
    expect(archived).toMatchObject({
      status: "archived",
      currentVersionId: listed.currentVersionId,
      access: "private",
      discoverability: "link_only",
      hasPassword: false,
      sharedExpiresAt: null,
      galleryListed: false,
      galleryTemplatable: false,
    });
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

    // Gallery intent is the Whole-org discovery opt-in: MCP shares the settings
    // resolver with HTTP, so one call persists both facts and returns read-your-writes.
    const listed = payload(
      await mcp.callTool({
        name: "update_canvas",
        arguments: { id: cv.id, galleryListed: true },
      }),
    );
    expect(listed).toMatchObject({ discoverability: "listed", galleryListed: true });

    // public_link is default-on, then denied after a per-user revoke.
    expect(
      isError(
        await mcp.callTool({
          name: "update_canvas",
          arguments: { id: cv.id, access: "public_link" },
        }),
      ),
    ).toBe(false);
    await usersRepository(client).setPublishPublic(userId, false);
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

  it("list_versions exposes bearer download URLs and delete_version removes only history", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    for (const html of ["<h1>one</h1>", "<h1>two</h1>"]) {
      await mcp.callTool({
        name: "deploy_canvas",
        arguments: { id: cv.id, zipBase64: zip({ "index.html": html }) },
      });
    }

    const before = payload(await mcp.callTool({ name: "list_versions", arguments: { id: cv.id } }));
    expect(before.versions.map((version: { number: number }) => version.number)).toEqual([2, 1]);
    expect(before.versions[0].downloadUrl).toBe(
      `http://localhost:3000/mcp/canvases/${cv.id}/versions/2/download`,
    );

    expect(
      isError(await mcp.callTool({ name: "delete_version", arguments: { id: cv.id, version: 2 } })),
    ).toBe(true);
    expect(
      payload(await mcp.callTool({ name: "delete_version", arguments: { id: cv.id, version: 1 } })),
    ).toEqual({ ok: true, version: 1 });

    const after = payload(await mcp.callTool({ name: "list_versions", arguments: { id: cv.id } }));
    expect(after.versions.map((version: { number: number }) => version.number)).toEqual([2]);
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

  it("grant_access adds an existing user; list/revoke reflect it", async () => {
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
    expect(granted).toMatchObject({ ok: true, status: "granted" });

    const access = payload(await mcp.callTool({ name: "list_access", arguments: { id: cv.id } }));
    // The owner row is pinned first (KTD5); the granted member follows with its role.
    expect(access.entries).toHaveLength(2);
    expect(access.entries[0]).toMatchObject({ id: "owner", kind: "owner", role: "owner" });
    expect(access.entries[1]).toMatchObject({
      kind: "member",
      email: "teammate@example.com",
      role: "viewer",
    });

    const ok = payload(
      await mcp.callTool({
        name: "revoke_access",
        arguments: { id: cv.id, entryId: access.entries[1].id },
      }),
    );
    expect(ok.ok).toBe(true);
    const after = payload(await mcp.callTool({ name: "list_access", arguments: { id: cv.id } }));
    expect(after.entries).toHaveLength(1);

    // The legacy guest-invite path is retired; unknown self-serve external emails are denied
    // through the shared Add person policy, not by minting app-owned magic links.
    const external = await mcp.callTool({
      name: "grant_access",
      arguments: { id: cv.id, email: "outsider@external.test" },
    });
    expect(isError(external)).toBe(true);
    expect(text(external)).toContain("NOT_PERMITTED");
  });

  it("grant_access records admissible new emails as pending and revoke_access cancels them", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId: owner }, false, domainConfig);
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    const pending = payload(
      await mcp.callTool({
        name: "grant_access",
        arguments: { id: cv.id, email: "new-person@example.com" },
      }),
    );
    expect(pending).toMatchObject({ ok: true, status: "pending" });

    const access = payload(await mcp.callTool({ name: "list_access", arguments: { id: cv.id } }));
    expect(access.entries).toHaveLength(2);
    expect(access.entries[1]).toMatchObject({
      kind: "pending",
      email: "new-person@example.com",
    });

    const revoked = payload(
      await mcp.callTool({
        name: "revoke_access",
        arguments: { id: cv.id, entryId: access.entries[1].id },
      }),
    );
    expect(revoked.ok).toBe(true);
    const after = payload(await mcp.callTool({ name: "list_access", arguments: { id: cv.id } }));
    expect(after.entries).toHaveLength(1);
  });

  it("admin owners can admit a never-seen external email through grant_access", async () => {
    client = await makeTestDb(dialect);
    const admin = await seedUser(client, "admin@example.com", true);
    const mcp = await connect(client, { userId: admin, isAdmin: true });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));

    const pending = payload(
      await mcp.callTool({
        name: "grant_access",
        arguments: { id: cv.id, email: "contractor@external.test" },
      }),
    );
    expect(pending).toMatchObject({ ok: true, status: "pending" });
    expect(
      await invitationsRepository(client).listForEmail("contractor@external.test"),
    ).toHaveLength(1);
  });

  it("search_people mirrors the canvas Add person picker scope", async () => {
    client = await makeTestDb(dialect);
    const org = await orgsRepository(client).ensureOrg({
      name: "Example",
      slug: "example",
      domains: ["example.com"],
    });
    const owner = await seedUser(client, "owner@example.com");
    const colleague = await seedUser(client, "colleague@example.com");
    const alreadyAdded = await seedUser(client, "added@example.com");
    await seedUser(client, "outsider@example.com");
    const orgMembers = orgMembersRepository(client);
    for (const userId of [owner, colleague, alreadyAdded]) {
      await orgMembers.upsertDomainMember(org.id, userId);
    }
    const canvases = canvasesRepository(client);
    const cv = await canvases.create({
      ownerId: owner,
      slug: "org-picker",
      apiKeyHash: "h",
      orgId: org.id,
    });
    await canvases.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: alreadyAdded,
    });
    const mcp = await connect(client, {
      userId: owner,
      orgIds: new Set([org.id]),
      tenancyActive: true,
    });

    const result = payload(
      await mcp.callTool({
        name: "search_people",
        arguments: { context: "canvas", canvasId: cv.id, q: "example" },
      }),
    );
    expect(result.people.map((p: { email: string }) => p.email)).toEqual(["colleague@example.com"]);
  });

  it("does not expose the retired resend_guest_invite tool", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId: owner });

    const tools = await mcp.listTools();
    expect(tools.tools.map((tool) => tool.name)).not.toContain("resend_guest_invite");
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
      "list_canvas_connections",
      "list_versions",
      "delete_version",
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
    // The audience filter the dashboard lists send (parity): fresh canvases are Restricted.
    const restricted = payload(
      await mcp.callTool({ name: "list_canvases", arguments: { access: "restricted" } }),
    );
    expect(restricted.total).toBe(2);
    // biome-ignore lint/suspicious/noExplicitAny: JSON payload
    expect(restricted.canvases.every((c: any) => c.accessMode === "restricted")).toBe(true);
    const org = payload(
      await mcp.callTool({ name: "list_canvases", arguments: { access: "whole_org" } }),
    );
    expect(org.total).toBe(0);
  });

  it("list_canvases mirrors management scope, state chips, paging, summary, and literal access filters", async () => {
    client = await makeTestDb(dialect);
    const email = `list-${dialect}@example.com`;
    const cfg = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_DEV_USER_EMAIL: email,
    });
    const app = managementApp(client, cfg);
    const headers = { host: "localhost:3000" };

    // Materialize the same dev identity the HTTP list uses, then bind MCP to that
    // server-derived account id.
    expect((await app.request("/api/canvases", { headers })).status).toBe(200);
    const actor = await usersRepository(client).findByEmail(email);
    if (!actor) throw new Error("dev actor was not materialized");
    const mcp = await connect(client, { userId: actor.id }, false, cfg);
    const repo = canvasesRepository(client);

    const make = async (title: string) =>
      payload(await mcp.callTool({ name: "create_canvas", arguments: { title } })) as {
        id: string;
      };
    const deployed = await make("A deployed");
    await mcp.callTool({
      name: "deploy_canvas",
      arguments: { id: deployed.id, files: [{ path: "index.html", content: "ok" }] },
    });
    const protectedCanvas = await make("B protected");
    await repo.setPassword(protectedCanvas.id, "argon2hash");
    const listedCanvas = await make("C listed");
    await repo.updateSettings(listedCanvas.id, { galleryListed: true });
    const templateCanvas = await make("D template");
    await repo.updateSettings(templateCanvas.id, {
      galleryListed: true,
      galleryTemplatable: true,
    });
    const undeployed = await make("E undeployed");
    const archived = await make("F archived");
    await repo.archive(archived.id);
    const specific = await make("G specific");
    await repo.setAccess(specific.id, "specific_people");
    const team = await make("H team");
    await repo.setAccess(team.id, "team");
    const publicLink = await make("I public");
    await repo.setAccess(publicLink.id, "public_link");

    type ListBody = {
      total: number;
      limit: number;
      offset: number;
      summary: Record<string, number>;
      canvases: Array<{ id: string; access: string }>;
    };
    const http = async (query = "") => {
      const res = await app.request(`/api/canvases${query}`, { headers });
      expect(res.status).toBe(200);
      return (await res.json()) as ListBody;
    };
    const overMcp = async (arguments_: Record<string, unknown> = {}) =>
      payload(await mcp.callTool({ name: "list_canvases", arguments: arguments_ })) as ListBody;
    const sortedIds = (body: ListBody) => body.canvases.map((cv) => cv.id).sort();

    const active = await overMcp();
    expect(sortedIds(active)).not.toContain(archived.id);
    const archivedMcp = await overMcp({ scope: "archived" });
    const archivedHttp = await http("?scope=archived&limit=100");
    expect(sortedIds(archivedMcp)).toEqual([archived.id]);
    expect(sortedIds(archivedMcp)).toEqual(sortedIds(archivedHttp));

    for (const [name, expectedId] of [
      ["shared", publicLink.id],
      ["protected", protectedCanvas.id],
      ["listed", listedCanvas.id],
      ["template", templateCanvas.id],
      ["undeployed", undeployed.id],
    ] as const) {
      const mcpBody = await overMcp({ [name]: true, limit: 100 });
      const httpBody = await http(`?${name}=1&limit=100`);
      expect(sortedIds(mcpBody), name).toEqual(sortedIds(httpBody));
      expect(sortedIds(mcpBody), name).toContain(expectedId);
      expect(mcpBody.total, name).toBe(httpBody.total);
    }

    const firstPage = await overMcp({ sort: "title", limit: 2, offset: 0 });
    const secondPage = await overMcp({ sort: "title", limit: 2, offset: 2 });
    const secondHttp = await http("?sort=title&limit=2&offset=2");
    expect(secondPage.canvases.map((cv) => cv.id)).toEqual(secondHttp.canvases.map((cv) => cv.id));
    expect(secondPage.total).toBe(firstPage.total);
    expect(secondPage.limit).toBe(2);
    expect(secondPage.offset).toBe(2);
    expect(firstPage.canvases.map((cv) => cv.id)).not.toEqual(
      secondPage.canvases.map((cv) => cv.id),
    );

    const httpSummary = (await http()).summary;
    expect(active.summary).toEqual(httpSummary);

    for (const access of ["private", "specific_people", "team", "public_link"] as const) {
      const mcpBody = await overMcp({ access, limit: 100 });
      const httpBody = await http(`?access=${access}&limit=100`);
      expect(sortedIds(mcpBody), access).toEqual(sortedIds(httpBody));
      expect(
        mcpBody.canvases.every((cv) => cv.access === access),
        access,
      ).toBe(true);
    }

    const restricted = await overMcp({ access: "restricted", limit: 100 });
    const restrictedHttp = await http("?access=restricted&limit=100");
    expect(sortedIds(restricted)).toEqual(sortedIds(restrictedHttp));
    expect(restricted.total).toBe(restrictedHttp.total);
    expect(new Set(restricted.canvases.map((cv) => cv.access))).toEqual(
      new Set(["private", "specific_people", "team"]),
    );

    for (const [arguments_, query, expectedLimit, expectedOffset] of [
      [{ limit: 0, offset: -1 }, "?limit=0&offset=-1", 1, 0],
      [{ limit: 101 }, "?limit=101", 100, 0],
      [{ scope: "not-a-scope" }, "?scope=not-a-scope", 50, 0],
    ] as const) {
      const mcpBody = await overMcp(arguments_ as Record<string, unknown>);
      const httpBody = await http(query);
      expect(sortedIds(mcpBody), query).toEqual(sortedIds(httpBody));
      expect(mcpBody.total, query).toBe(httpBody.total);
      expect(mcpBody.limit, query).toBe(expectedLimit);
      expect(mcpBody.offset, query).toBe(expectedOffset);
    }
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

  it("list_canvases tags filters to canvases carrying any of the given tags (any-match parity)", async () => {
    client = await makeTestDb(dialect);
    const userId = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId });
    const charts = payload(
      await mcp.callTool({ name: "create_canvas", arguments: { title: "Charts" } }),
    );
    const other = payload(
      await mcp.callTool({ name: "create_canvas", arguments: { title: "Other" } }),
    );
    await mcp.callTool({
      name: "update_canvas",
      arguments: { id: charts.id, tags: ["charts"] },
    });
    await mcp.callTool({
      name: "update_canvas",
      arguments: { id: other.id, tags: ["finance"] },
    });

    const onlyCharts = payload(
      await mcp.callTool({ name: "list_canvases", arguments: { tags: ["charts"] } }),
    );
    expect(onlyCharts.total).toBe(1);
    // biome-ignore lint/suspicious/noExplicitAny: test payload is untyped JSON
    expect(onlyCharts.canvases.map((cv: any) => cv.id)).toEqual([charts.id]);

    // Any-match: passing both tags returns both canvases.
    const both = payload(
      await mcp.callTool({
        name: "list_canvases",
        arguments: { tags: ["charts", "finance"] },
      }),
    );
    expect(both.total).toBe(2);
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: test payload is untyped JSON
      both.canvases.map((cv: any) => cv.id).sort(),
    ).toEqual([charts.id, other.id].sort());
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
    const canvases = canvasesRepository(client);
    expect((await canvases.findById(made.id))?.revokedAt).toBeNull();
    expect(await canvases.revoke(made.id)).toBeTruthy();
    expect((await canvases.findById(made.id))?.revokedAt).not.toBeNull();

    const republished = payload(
      await mcp.callTool({
        name: "deploy_canvas",
        arguments: { id: made.id, zipBase64: zip({ "index.html": "v3" }) },
      }),
    );
    expect(republished.version).toBe(3);
    expect((await canvases.findById(made.id))?.revokedAt).toBeNull();
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

    // publish_draft on an ARCHIVED (not disabled) canvas keeps the NOT_ACTIVE
    // ("unarchive first") message — it must NOT collapse into the DISABLED contract,
    // since archive is owner-reversible while disable is an admin takedown.
    const publishRes = await mcp.callTool({
      name: "publish_draft",
      arguments: { id: made.id },
    });
    expect(isError(publishRes)).toBe(true);
    expect(text(publishRes)).toContain("NOT_ACTIVE");
    expect(text(publishRes)).not.toContain("DISABLED");
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

describe.each(DIALECTS)("MCP tenancy parity (plan 002 U7) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seedTwoOrgs() {
    const orgs = orgsRepository(client);
    const a = await orgs.ensureOrg({ name: "A", slug: "a", domains: ["a.example"] });
    const b = await orgs.ensureOrg({ name: "B", slug: "b", domains: ["b.example"] });
    return { a, b };
  }

  it("whoami exposes the caller's orgs + isGuest, server-resolved", async () => {
    client = await makeTestDb(dialect);
    const { a } = await seedTwoOrgs();
    const memberId = await seedUser(client, "m@a.example");
    const member = await connect(client, {
      userId: memberId,
      orgIds: new Set([a.id]),
      tenancyActive: true,
    });
    expect(payload(await member.callTool({ name: "whoami", arguments: {} }))).toMatchObject({
      orgs: [{ id: a.id, name: "A" }],
      isGuest: false,
    });

    const guestId = await seedUser(client, "g@gmail.com");
    const guest = await connect(client, {
      userId: guestId,
      orgIds: new Set(),
      tenancyActive: true,
    });
    expect(payload(await guest.callTool({ name: "whoami", arguments: {} }))).toMatchObject({
      orgs: [],
      isGuest: true,
    });
  });

  it("create_canvas homes a canvas in an org the caller belongs to", async () => {
    client = await makeTestDb(dialect);
    const { a } = await seedTwoOrgs();
    const memberId = await seedUser(client, "m@a.example");
    const mcp = await connect(client, {
      userId: memberId,
      orgIds: new Set([a.id]),
      tenancyActive: true,
    });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: { orgId: a.id } }));
    const row = await canvasesRepository(client).findById(cv.id);
    expect(row?.orgId).toBe(a.id);
  });

  it("create_canvas REJECTS an org the caller is not a member of (never trust the client)", async () => {
    client = await makeTestDb(dialect);
    const { a, b } = await seedTwoOrgs();
    const memberId = await seedUser(client, "m@a.example");
    const mcp = await connect(client, {
      userId: memberId,
      orgIds: new Set([a.id]),
      tenancyActive: true,
    });
    const res = await mcp.callTool({ name: "create_canvas", arguments: { orgId: b.id } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toContain("ORG_FORBIDDEN");
  });

  it("create_canvas with explicit null org_id is personal (org_id stays null)", async () => {
    client = await makeTestDb(dialect);
    const { a } = await seedTwoOrgs();
    const memberId = await seedUser(client, "m@a.example");
    const mcp = await connect(client, {
      userId: memberId,
      orgIds: new Set([a.id]),
      tenancyActive: true,
    });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: { orgId: null } }));
    const row = await canvasesRepository(client).findById(cv.id);
    expect(row?.orgId).toBeNull();
  });
});

describe.each(DIALECTS)("MCP team parity (plan 003 U6) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seedOrg() {
    return orgsRepository(client).ensureOrg({ name: "A", slug: "a", domains: ["a.example"] });
  }
  /** Seed a user AND materialize their org membership (so they're a same-org member). */
  async function member(email: string, orgId: string) {
    const id = await seedUser(client, email);
    await orgMembersRepository(client).upsertDomainMember(orgId, id);
    return id;
  }
  // Tenancy config so `update_canvas access=team` sees tenancy active (the guard reads
  // config.org.name). The seeded org id is what homes the canvas; the config name only
  // flips the tenancy switch on.
  const tenantConfig = loadConfig({ CANVAS_DROP_ORG_NAME: "A" });
  const connectMember = (userId: string, orgId: string) =>
    connect(client, { userId, orgIds: new Set([orgId]), tenancyActive: true }, false, tenantConfig);
  const html = () => zip({ "index.html": "<h1>hi</h1>" });

  it("create_team + list_teams: a member creates and manages a team", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const mcp = await connectMember(ownerId, org.id);
    const team = payload(
      await mcp.callTool({ name: "create_team", arguments: { orgId: org.id, name: "Design" } }),
    );
    expect(team).toMatchObject({ orgId: org.id, name: "Design" });
    const { teams } = payload(await mcp.callTool({ name: "list_teams", arguments: {} }));
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({ id: team.id, mine: true, canManage: true });
  });

  it("create_team is denied for an org you don't belong to", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const outsiderId = await seedUser(client, "out@b.example");
    const mcp = await connect(client, {
      userId: outsiderId,
      orgIds: new Set<string>(),
      tenancyActive: true,
    });
    const res = await mcp.callTool({
      name: "create_team",
      arguments: { orgId: org.id, name: "X" },
    });
    expect(isError(res)).toBe(true);
    expect(text(res)).toContain("NOT_A_MEMBER");
  });

  it("add_team_member adds a same-org colleague; rejects a non-org user", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const colleagueId = await member("col@a.example", org.id);
    await seedUser(client, "out@b.example"); // exists but no org membership
    const mcp = await connectMember(ownerId, org.id);
    const team = payload(
      await mcp.callTool({ name: "create_team", arguments: { orgId: org.id, name: "Design" } }),
    );
    expect(
      isError(
        await mcp.callTool({
          name: "add_team_member",
          arguments: { id: team.id, email: "col@a.example" },
        }),
      ),
    ).toBe(false);
    const { members } = payload(
      await mcp.callTool({ name: "list_team_members", arguments: { id: team.id } }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: JSON payload
    expect(members.map((m: any) => m.userId).sort()).toEqual([ownerId, colleagueId].sort());
    const bad = await mcp.callTool({
      name: "add_team_member",
      arguments: { id: team.id, email: "out@b.example" },
    });
    expect(isError(bad)).toBe(true);
    expect(text(bad)).toContain("TARGET_NOT_MEMBER");
  });

  it("create_team (no orgId) makes a PERSONAL team; add_team_member grants an existing user, rejects a brand-new external email (plan 003 U9)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedUser(client, "owner@nowhere.test"); // no org
    const palId = await seedUser(client, "pal@nowhere.test"); // existing user, no org
    const mcp = await connect(client, {
      userId: ownerId,
      orgIds: new Set<string>(),
      tenancyActive: false,
    });

    const team = payload(
      await mcp.callTool({ name: "create_team", arguments: { name: "Family" } }),
    );
    expect(team.orgId).toBeNull();

    // Existing user → granted now.
    const granted = payload(
      await mcp.callTool({
        name: "add_team_member",
        arguments: { id: team.id, email: "pal@nowhere.test" },
      }),
    );
    expect(granted).toMatchObject({ status: "granted" });
    const { members } = payload(
      await mcp.callTool({ name: "list_team_members", arguments: { id: team.id } }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: JSON payload
    expect(members.map((m: any) => m.userId).sort()).toEqual([ownerId, palId].sort());

    // Brand-new external email, self-serve (non-admin), toggle off → refused (KTD5).
    const refused = await mcp.callTool({
      name: "add_team_member",
      arguments: { id: team.id, email: "stranger@elsewhere.test" },
    });
    expect(isError(refused)).toBe(true);
    expect(text(refused)).toContain("TARGET_NOT_PERMITTED");
  });

  it("cancel_team_invite removes a pending roster row (parity with the HTTP cancel); foreign/unknown ids fail", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedUser(client, "owner@nowhere.test");
    const strangerId = await seedUser(client, "stranger@nowhere.test");
    const invitations = invitationsRepository(client);
    const mcp = await connect(client, {
      userId: ownerId,
      orgIds: new Set<string>(),
      tenancyActive: false,
    });

    const team = payload(
      await mcp.callTool({ name: "create_team", arguments: { name: "Family" } }),
    );
    await invitations.record({
      email: "friend@external.test",
      target: { type: "team", id: team.id },
      invitedBy: ownerId,
    });

    // The pending row surfaces with its cancelable id.
    const roster = payload(
      await mcp.callTool({ name: "list_team_members", arguments: { id: team.id } }),
    );
    expect(roster.pending).toHaveLength(1);
    const inviteId = roster.pending[0].id as string;
    expect(inviteId).toBeTruthy();

    // A non-member can't see the team, so the cancel reads as not-found.
    const strangerMcp = await connect(client, {
      userId: strangerId,
      orgIds: new Set<string>(),
      tenancyActive: false,
    });
    const denied = await strangerMcp.callTool({
      name: "cancel_team_invite",
      arguments: { id: team.id, inviteId },
    });
    expect(isError(denied)).toBe(true);

    // A member cancels it; the roster's pending list empties; a re-cancel fails.
    payload(
      await mcp.callTool({ name: "cancel_team_invite", arguments: { id: team.id, inviteId } }),
    );
    const after = payload(
      await mcp.callTool({ name: "list_team_members", arguments: { id: team.id } }),
    );
    expect(after.pending).toHaveLength(0);
    const again = await mcp.callTool({
      name: "cancel_team_invite",
      arguments: { id: team.id, inviteId },
    });
    expect(isError(again)).toBe(true);
    expect(text(again)).toContain("TARGET_NOT_FOUND");
  });

  it("invite_to_canvas mirrors the HTTP denials: existing user granted, brand-new external rejected (plan 003 U9)", async () => {
    client = await makeTestDb(dialect);
    const ownerId = await seedUser(client, "owner@nowhere.test");
    await seedUser(client, "pal@nowhere.test");
    const mcp = await connect(client, {
      userId: ownerId,
      orgIds: new Set<string>(),
      tenancyActive: false,
    });
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    await mcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });

    const granted = payload(
      await mcp.callTool({
        name: "invite_to_canvas",
        arguments: { id: cv.id, email: "pal@nowhere.test" },
      }),
    );
    expect(granted).toMatchObject({ status: "granted" });

    const refused = await mcp.callTool({
      name: "invite_to_canvas",
      arguments: { id: cv.id, email: "stranger@elsewhere.test" },
    });
    expect(isError(refused)).toBe(true);
    expect(text(refused)).toContain("NOT_PERMITTED");
  });

  it("update_canvas access=team grants the team; get_canvas echoes teamIds", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const mcp = await connectMember(ownerId, org.id);
    const team = payload(
      await mcp.callTool({ name: "create_team", arguments: { orgId: org.id, name: "Design" } }),
    );
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: { orgId: org.id } }));
    await mcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    // An empty team grant is refused (a deny to everyone).
    const empty = await mcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, access: "team", teamIds: [] },
    });
    expect(isError(empty)).toBe(true);
    expect(text(empty)).toContain("TEAM_REQUIRED");
    const granted = payload(
      await mcp.callTool({
        name: "update_canvas",
        arguments: { id: cv.id, access: "team", teamIds: [team.id] },
      }),
    );
    expect(granted).toMatchObject({ access: "team", teamIds: [team.id] });
    const got = payload(await mcp.callTool({ name: "get_canvas", arguments: { id: cv.id } }));
    expect(got.teamIds).toEqual([team.id]);
  });

  it("update_canvas rejects granting a team you don't belong to", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const otherId = await member("other@a.example", org.id);
    const ownerMcp = await connectMember(ownerId, org.id);
    const otherMcp = await connectMember(otherId, org.id);
    const theirTeam = payload(
      await otherMcp.callTool({
        name: "create_team",
        arguments: { orgId: org.id, name: "Theirs" },
      }),
    );
    const cv = payload(
      await ownerMcp.callTool({ name: "create_canvas", arguments: { orgId: org.id } }),
    );
    await ownerMcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    const res = await ownerMcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, access: "team", teamIds: [theirTeam.id] },
    });
    expect(isError(res)).toBe(true);
    expect(text(res)).toContain("TEAM_FORBIDDEN");
  });

  it("list_shared_canvases surfaces a team-granted canvas to a teammate at once (no discoverability opt-in), never to the owner", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const mateId = await member("mate@a.example", org.id);
    const ownerMcp = await connectMember(ownerId, org.id);
    const team = payload(
      await ownerMcp.callTool({
        name: "create_team",
        arguments: { orgId: org.id, name: "Design" },
      }),
    );
    await ownerMcp.callTool({
      name: "add_team_member",
      arguments: { id: team.id, email: "mate@a.example" },
    });
    const cv = payload(
      await ownerMcp.callTool({
        name: "create_canvas",
        arguments: { orgId: org.id, title: "Team Thing" },
      }),
    );
    await ownerMcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    await ownerMcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, access: "team", teamIds: [team.id] },
    });
    await ownerMcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, password: "secret" },
    });
    const mateMcp = await connectMember(mateId, org.id);
    // The owner does NOT see their own canvas in Shared.
    expect(
      payload(await ownerMcp.callTool({ name: "list_shared_canvases", arguments: {} })).canvases,
    ).toHaveLength(0);
    // The teammate does, immediately: a team on the list is an open door (restricted access
    // model) — no `discoverability` opt-in, which now only governs whole_org listing.
    const { canvases } = payload(
      await mateMcp.callTool({ name: "list_shared_canvases", arguments: { query: "design" } }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: JSON payload
    expect(canvases.map((c: any) => c.id)).toContain(cv.id);
    expect(canvases[0]).toMatchObject({
      access: { kind: "team", label: "Design", teamNames: ["Design"] },
      hasPassword: true,
    });
  });

  it("list_shared_canvases surfaces only listed Whole-org canvases to same-org non-owners", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const otherOrg = await orgsRepository(client).ensureOrg({
      name: "B",
      slug: "b",
      domains: ["b.example"],
    });
    const ownerId = await member("owner@a.example", org.id);
    const mateId = await member("mate@a.example", org.id);
    const outsiderId = await member("outsider@b.example", otherOrg.id);
    const noOrgId = await seedUser(client, "guest@example.net");
    const ownerMcp = await connectMember(ownerId, org.id);
    const cv = payload(
      await ownerMcp.callTool({
        name: "create_canvas",
        arguments: { orgId: org.id, title: "Org Thing" },
      }),
    );
    await ownerMcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    await ownerMcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, access: "whole_org" },
    });

    const mateMcp = await connectMember(mateId, org.id);
    expect(
      payload(await mateMcp.callTool({ name: "list_shared_canvases", arguments: {} })).canvases,
    ).toHaveLength(0);

    await ownerMcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, discoverability: "listed" },
    });

    expect(
      payload(await ownerMcp.callTool({ name: "list_shared_canvases", arguments: {} })).canvases,
    ).toHaveLength(0);
    const { canvases } = payload(
      await mateMcp.callTool({ name: "list_shared_canvases", arguments: { query: "org" } }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: JSON payload
    expect(canvases.map((c: any) => c.id)).toEqual([cv.id]);
    expect(canvases[0]).toMatchObject({ access: { kind: "whole_org", label: "Whole org" } });

    const outsiderMcp = await connectMember(outsiderId, otherOrg.id);
    expect(
      payload(await outsiderMcp.callTool({ name: "list_shared_canvases", arguments: {} })).canvases,
    ).toHaveLength(0);
    const noOrgMcp = await connect(
      client,
      { userId: noOrgId, orgIds: new Set(), tenancyActive: true },
      false,
      tenantConfig,
    );
    expect(
      payload(await noOrgMcp.callTool({ name: "list_shared_canvases", arguments: {} })).canvases,
    ).toHaveLength(0);
  });

  it("update_canvas audits discoverability-only share changes", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const ownerMcp = await connectMember(ownerId, org.id);
    const cv = payload(
      await ownerMcp.callTool({
        name: "create_canvas",
        arguments: { orgId: org.id, title: "Audited" },
      }),
    );
    await ownerMcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    await ownerMcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, access: "whole_org" },
    });
    await ownerMcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, discoverability: "listed" },
    });

    await vi.waitFor(async () => {
      const rows = await auditRepository(client).recent(20);
      const discoveryAudit = rows.find((row) => {
        const meta = row.meta;
        return (
          row.action === "share_change" &&
          meta !== null &&
          typeof meta === "object" &&
          !Array.isArray(meta) &&
          meta.discoverability === "listed"
        );
      });
      expect(discoveryAudit?.targetId).toBe(cv.id);
    });
  });

  it("clone_canvas: a team member may clone a team canvas; a non-member cannot", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const mateId = await member("mate@a.example", org.id);
    const strangerId = await member("stranger@a.example", org.id);
    // ONE shared blob store so the clone (on the teammate's connection) can read the
    // source's deployed files the owner's connection wrote.
    const store = memStorage();
    const conn = (userId: string) =>
      connect(
        client,
        { userId, orgIds: new Set([org.id]), tenancyActive: true },
        false,
        tenantConfig,
        store,
      );
    const ownerMcp = await conn(ownerId);
    const team = payload(
      await ownerMcp.callTool({
        name: "create_team",
        arguments: { orgId: org.id, name: "Design" },
      }),
    );
    await ownerMcp.callTool({
      name: "add_team_member",
      arguments: { id: team.id, email: "mate@a.example" },
    });
    const cv = payload(
      await ownerMcp.callTool({ name: "create_canvas", arguments: { orgId: org.id } }),
    );
    await ownerMcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    await ownerMcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, access: "team", teamIds: [team.id] },
    });
    // The teammate clones it into a fresh canvas they own.
    const cloned = payload(
      await (await conn(mateId)).callTool({ name: "clone_canvas", arguments: { id: cv.id } }),
    );
    expect(cloned.id).toBeTruthy();
    expect(cloned.id).not.toBe(cv.id);
    // A same-org NON-member of the team can't — it reads as not found.
    const denied = await (await conn(strangerId)).callTool({
      name: "clone_canvas",
      arguments: { id: cv.id },
    });
    expect(isError(denied)).toBe(true);
    expect(text(denied)).toContain("not found");
  });

  it("clone_canvas: direct and team viewers may clone the same eligible Restricted canvas", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const mateId = await member("mate@a.example", org.id);
    const strangerId = await member("stranger@a.example", org.id);
    const noGrantId = await member("no-grant@a.example", org.id);
    const store = memStorage();
    const conn = (userId: string) =>
      connect(
        client,
        { userId, orgIds: new Set([org.id]), tenancyActive: true },
        false,
        tenantConfig,
        store,
      );
    const ownerMcp = await conn(ownerId);
    const team = payload(
      await ownerMcp.callTool({
        name: "create_team",
        arguments: { orgId: org.id, name: "Design" },
      }),
    );
    await ownerMcp.callTool({
      name: "add_team_member",
      arguments: { id: team.id, email: "mate@a.example" },
    });
    const cv = payload(
      await ownerMcp.callTool({ name: "create_canvas", arguments: { orgId: org.id } }),
    );
    await ownerMcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    // The team goes on the people-and-teams list; General access stays Restricted (`private`).
    await ownerMcp.callTool({
      name: "grant_access",
      arguments: { id: cv.id, teamId: team.id, role: "viewer" },
    });
    await ownerMcp.callTool({
      name: "grant_access",
      arguments: { id: cv.id, email: "stranger@a.example", role: "viewer" },
    });
    const repo = canvasesRepository(client);
    // Neither an email-only legacy guest row nor a pending invitation is a durable
    // member grant, even when the signed-in account has the same email.
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "guest",
      email: "no-grant@a.example",
      role: "viewer",
    });
    await invitationsRepository(client).record({
      email: "no-grant@a.example",
      target: { type: "canvas", id: cv.id },
      role: "viewer",
      invitedBy: ownerId,
    });
    expect(
      payload(await ownerMcp.callTool({ name: "get_canvas", arguments: { id: cv.id } })).access,
    ).toBe("private");
    const cloned = payload(
      await (await conn(mateId)).callTool({ name: "clone_canvas", arguments: { id: cv.id } }),
    );
    expect(cloned.id).toBeTruthy();
    expect(cloned.id).not.toBe(cv.id);
    const directClone = payload(
      await (await conn(strangerId)).callTool({ name: "clone_canvas", arguments: { id: cv.id } }),
    );
    expect(directClone.id).toBeTruthy();
    expect(directClone.id).not.toBe(cv.id);

    const noGrantMcp = await conn(noGrantId);
    const restrictedDenied = await noGrantMcp.callTool({
      name: "clone_canvas",
      arguments: { id: cv.id },
    });
    expect(isError(restrictedDenied)).toBe(true);
    expect(text(restrictedDenied)).toContain("not found");
    for (const access of ["whole_org", "public_link"] as const) {
      await repo.updateSettings(cv.id, { access });
      for (const grantedId of [mateId, strangerId]) {
        const granted = await (await conn(grantedId)).callTool({
          name: "clone_canvas",
          arguments: { id: cv.id },
        });
        expect(isError(granted), `${grantedId} ${access}`).toBe(false);
      }
      const denied = await noGrantMcp.callTool({
        name: "clone_canvas",
        arguments: { id: cv.id },
      });
      expect(isError(denied), access).toBe(true);
      expect(text(denied)).toContain("not found");
    }
  });

  it("clone_canvas applies the same source fences to direct and team viewers", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const mateId = await member("mate@a.example", org.id);
    const directId = await member("direct@a.example", org.id);
    const store = memStorage();
    const conn = (userId: string) =>
      connect(
        client,
        { userId, orgIds: new Set([org.id]), tenancyActive: true },
        false,
        tenantConfig,
        store,
      );
    const ownerMcp = await conn(ownerId);
    const mateMcp = await conn(mateId);
    const directMcp = await conn(directId);
    const team = payload(
      await ownerMcp.callTool({
        name: "create_team",
        arguments: { orgId: org.id, name: "Design" },
      }),
    );
    await ownerMcp.callTool({
      name: "add_team_member",
      arguments: { id: team.id, email: "mate@a.example" },
    });
    const cv = payload(
      await ownerMcp.callTool({ name: "create_canvas", arguments: { orgId: org.id } }),
    );
    await ownerMcp.callTool({
      name: "grant_access",
      arguments: { id: cv.id, teamId: team.id, role: "viewer" },
    });
    await ownerMcp.callTool({
      name: "grant_access",
      arguments: { id: cv.id, email: "direct@a.example", role: "viewer" },
    });
    const cloneAsViewers = () =>
      Promise.all([
        mateMcp.callTool({ name: "clone_canvas", arguments: { id: cv.id } }),
        directMcp.callTool({ name: "clone_canvas", arguments: { id: cv.id } }),
      ]);
    const expectNotFound = async () => {
      for (const result of await cloneAsViewers()) {
        expect(isError(result)).toBe(true);
        expect(text(result)).toContain("not found");
      }
    };
    // Never published: the clone would be seeded from the owner's private draft.
    await expectNotFound();
    await ownerMcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    // Password-protected: the cloner would own the copy and bypass the gate.
    const repo = canvasesRepository(client);
    await repo.setPassword(cv.id, "argon2hash");
    await expectNotFound();
    await repo.setPassword(cv.id, null);
    // Expired share: the serve seam denies the same member.
    await repo.updateSettings(cv.id, { sharedExpiresAt: Date.now() - 60_000 });
    await expectNotFound();
    await repo.updateSettings(cv.id, { sharedExpiresAt: null });
    // Offline lifecycle rows never become a back door to the source bytes.
    await repo.archive(cv.id);
    await expectNotFound();
    await repo.unarchive(cv.id);
    await ownerMcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    await repo.setDisabled(cv.id, "policy");
    await expectNotFound();
    await repo.enable(cv.id);
    // Published, unprotected, unexpired: both grant shapes clone it (still Restricted).
    expect(
      payload(await ownerMcp.callTool({ name: "get_canvas", arguments: { id: cv.id } })).access,
    ).toBe("private");
    for (const result of await cloneAsViewers()) {
      const cloned = payload(result);
      expect(cloned.id).toBeTruthy();
      expect(cloned.id).not.toBe(cv.id);
    }
    await repo.setStatus(cv.id, "deleted");
    await expectNotFound();
  });

  it("the deprecated shared:false + teamIds:[] leave-Team shape is accepted and keeps grants", async () => {
    client = await makeTestDb(dialect);
    const email = `legacy-team-${dialect}@example.com`;
    const cfg = loadConfig({
      CANVAS_DROP_AUTH_MODE: "dev",
      CANVAS_DROP_DEV_USER_EMAIL: email,
    });
    const app = managementApp(client, cfg);
    expect(
      (await app.request("/api/canvases", { headers: { host: "localhost:3000" } })).status,
    ).toBe(200);
    const actor = await usersRepository(client).findByEmail(email);
    if (!actor) throw new Error("dev actor was not materialized");
    const actorId = actor.id;
    const mcp = await connect(client, { userId: actorId }, false, cfg);
    const team = payload(
      await mcp.callTool({ name: "create_team", arguments: { name: "Legacy viewers" } }),
    );
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: {} }));
    await mcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    await mcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, access: "team", teamIds: [team.id] },
    });

    const response = await app.request(`/api/canvases/${cv.id}/settings`, {
      method: "PATCH",
      headers: {
        host: "localhost:3000",
        "content-type": "application/json",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ shared: false, teamIds: [] }),
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    expect(JSON.parse(responseText)).toMatchObject({ access: "private", teamIds: [team.id] });
  });

  it("update_canvas legacy `teamIds: []` carve-out (review #8/#9): a no-op when leaving the `team` value, TEAM_REQUIRED with any other access value; the grants survive", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const mcp = await connectMember(ownerId, org.id);
    const team = payload(
      await mcp.callTool({ name: "create_team", arguments: { orgId: org.id, name: "Design" } }),
    );
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: { orgId: org.id } }));
    await mcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    const granted = payload(
      await mcp.callTool({
        name: "update_canvas",
        arguments: { id: cv.id, access: "team", teamIds: [team.id] },
      }),
    );
    expect(granted.teamIds).toEqual([team.id]);
    // Leaving the team value with the legacy empty array: accepted, grants untouched.
    const off = payload(
      await mcp.callTool({
        name: "update_canvas",
        arguments: { id: cv.id, access: "whole_org", teamIds: [] },
      }),
    );
    expect(off).toMatchObject({ access: "whole_org", teamIds: [team.id] });
    // Off the team value, an empty array is refused whatever `access` says.
    for (const access of ["whole_org", "private", "team"]) {
      const refused = await mcp.callTool({
        name: "update_canvas",
        arguments: { id: cv.id, access, teamIds: [] },
      });
      expect(isError(refused), access).toBe(true);
      expect(text(refused)).toContain("TEAM_REQUIRED");
    }
    const got = payload(await mcp.callTool({ name: "get_canvas", arguments: { id: cv.id } }));
    expect(got).toMatchObject({ access: "whole_org", teamIds: [team.id] });
  });

  it("rename_team is creator-only over MCP (no admin bypass)", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const otherId = await member("other@a.example", org.id);
    const ownerMcp = await connectMember(ownerId, org.id);
    const team = payload(
      await ownerMcp.callTool({
        name: "create_team",
        arguments: { orgId: org.id, name: "Design" },
      }),
    );
    const otherMcp = await connectMember(otherId, org.id);
    const res = await otherMcp.callTool({
      name: "rename_team",
      arguments: { id: team.id, name: "Hacked" },
    });
    expect(isError(res)).toBe(true);
    expect(text(res)).toContain("FORBIDDEN");
    expect(
      isError(
        await ownerMcp.callTool({
          name: "rename_team",
          arguments: { id: team.id, name: "Design 2" },
        }),
      ),
    ).toBe(false);
  });

  it("update_canvas: a teamIds-only change re-grants an already-team canvas (no access re-send)", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const mcp = await connectMember(ownerId, org.id);
    const t1 = payload(
      await mcp.callTool({ name: "create_team", arguments: { orgId: org.id, name: "A" } }),
    );
    const t2 = payload(
      await mcp.callTool({ name: "create_team", arguments: { orgId: org.id, name: "B" } }),
    );
    const cv = payload(await mcp.callTool({ name: "create_canvas", arguments: { orgId: org.id } }));
    await mcp.callTool({ name: "deploy_canvas", arguments: { id: cv.id, zipBase64: html() } });
    await mcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, access: "team", teamIds: [t1.id] },
    });
    // teamIds WITHOUT access on an already-team canvas changes the grant set (was a no-op).
    const updated = payload(
      await mcp.callTool({ name: "update_canvas", arguments: { id: cv.id, teamIds: [t2.id] } }),
    );
    expect(updated.teamIds).toEqual([t2.id]);
    // An empty teamIds-only change is still rejected (no deny-to-everyone).
    const empty = await mcp.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, teamIds: [] },
    });
    expect(isError(empty)).toBe(true);
    expect(text(empty)).toContain("TEAM_REQUIRED");
  });

  it("rename_team is opaque (not-found, not forbidden) for a team in another org", async () => {
    client = await makeTestDb(dialect);
    const orgs = orgsRepository(client);
    const orgA = await orgs.ensureOrg({ name: "A", slug: "a", domains: ["a.example"] });
    const orgB = await orgs.ensureOrg({ name: "B", slug: "b", domains: ["b.example"] });
    const aliceId = await seedUser(client, "alice@a.example");
    await orgMembersRepository(client).upsertDomainMember(orgA.id, aliceId);
    const bobId = await seedUser(client, "bob@b.example");
    await orgMembersRepository(client).upsertDomainMember(orgB.id, bobId);
    // Bob creates a team in org B.
    const bobMcp = await connect(client, {
      userId: bobId,
      orgIds: new Set([orgB.id]),
      tenancyActive: true,
    });
    const team = payload(
      await bobMcp.callTool({ name: "create_team", arguments: { orgId: orgB.id, name: "Secret" } }),
    );
    // Alice (org A) can't even tell it exists — opaque not-found, never a 403.
    const aliceMcp = await connect(client, {
      userId: aliceId,
      orgIds: new Set([orgA.id]),
      tenancyActive: true,
    });
    const res = await aliceMcp.callTool({
      name: "rename_team",
      arguments: { id: team.id, name: "Hacked" },
    });
    expect(isError(res)).toBe(true);
    expect(text(res)).toContain("TEAM_NOT_FOUND");
  });

  it("whoami lists the caller's teams", async () => {
    client = await makeTestDb(dialect);
    const org = await seedOrg();
    const ownerId = await member("owner@a.example", org.id);
    const mcp = await connectMember(ownerId, org.id);
    const team = payload(
      await mcp.callTool({ name: "create_team", arguments: { orgId: org.id, name: "Design" } }),
    );
    const me = payload(await mcp.callTool({ name: "whoami", arguments: {} }));
    // biome-ignore lint/suspicious/noExplicitAny: JSON payload
    expect(me.teams.map((t: any) => t.id)).toContain(team.id);
  });
});

// --- Editor role gates (editor-roles plan U2, KTD1/KTD10) --------------------------------

describe.each(DIALECTS)("MCP — editor role gates [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  async function seedRoles() {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner@example.com");
    const editor = await seedUser(client, "editor@example.com");
    const viewer = await seedUser(client, "viewer@example.com");
    const nobody = await seedUser(client, "nobody@example.com");
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId: owner, slug: "mcp-roles", apiKeyHash: "k" });
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: editor,
      role: "editor",
    });
    await repo.addAllowlistEntry({ canvasId: cv.id, principalKind: "member", userId: viewer });
    return { repo, cv, owner, editor, viewer, nobody };
  }

  it("get_canvas / update_canvas as editor succeed on a PRIVATE canvas; viewer and no-role read the bare not-found", async () => {
    const { cv, editor, viewer, nobody } = await seedRoles();
    const asEditor = await connect(client, { userId: editor });
    const got = await asEditor.callTool({ name: "get_canvas", arguments: { id: cv.id } });
    expect(isError(got)).toBe(false);
    expect(payload(got).id).toBe(cv.id);
    const upd = await asEditor.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, title: "by editor" },
    });
    expect(isError(upd)).toBe(false);
    expect(payload(upd).title).toBe("by editor");
    for (const uid of [viewer, nobody]) {
      const c = await connect(client, { userId: uid });
      for (const name of ["get_canvas", "update_canvas", "delete_canvas", "get_draft"]) {
        const res = await c.callTool({ name, arguments: { id: cv.id } });
        expect(isError(res), `${name} as ${uid}`).toBe(true);
        expect(text(res)).toBe("canvas not found");
      }
    }
  });

  it("delete_canvas as editor fails with the OWNER_ONLY: prefix — before the disabled state; the owner's delete on a disabled canvas is DISABLED", async () => {
    const { repo, cv, owner, editor } = await seedRoles();
    const asEditor = await connect(client, { userId: editor });
    const refused = await asEditor.callTool({ name: "delete_canvas", arguments: { id: cv.id } });
    expect(isError(refused)).toBe(true);
    expect(text(refused)).toMatch(/^OWNER_ONLY: /);
    expect((await repo.findById(cv.id))?.status).toBe("active");

    await repo.setDisabled(cv.id, "abuse");
    const stillOwnerOnly = await asEditor.callTool({
      name: "delete_canvas",
      arguments: { id: cv.id },
    });
    expect(text(stillOwnerOnly)).toMatch(/^OWNER_ONLY: /);
    const editorMutation = await asEditor.callTool({
      name: "update_canvas",
      arguments: { id: cv.id, title: "x" },
    });
    expect(text(editorMutation)).toMatch(/^DISABLED: /);
    expect(isError(await asEditor.callTool({ name: "get_canvas", arguments: { id: cv.id } }))).toBe(
      false,
    );
    const asOwner = await connect(client, { userId: owner });
    const ownerDelete = await asOwner.callTool({ name: "delete_canvas", arguments: { id: cv.id } });
    expect(text(ownerDelete)).toMatch(/^DISABLED: /);
  });

  it("KTD2 over MCP: an editor with an EMPTY live org set under active tenancy reads not-found; inert tenancy admits them", async () => {
    const { cv, editor } = await seedRoles();
    const active = await connect(client, {
      userId: editor,
      orgIds: new Set(),
      tenancyActive: true,
    });
    const res = await active.callTool({ name: "get_canvas", arguments: { id: cv.id } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toBe("canvas not found");
    const inert = await connect(client, { userId: editor, tenancyActive: false });
    expect(isError(await inert.callTool({ name: "get_canvas", arguments: { id: cv.id } }))).toBe(
      false,
    );
  });
});

describe.each(DIALECTS)("MCP — editor staged deploy (editor-roles plan U3) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("begin_deploy → add_files → finalize_deploy succeeds as editor; a no-role member's finalize with that handle fails", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner@example.com");
    const editor = await seedUser(client, "editor@example.com");
    const nobody = await seedUser(client, "nobody@example.com");
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId: owner, slug: "staged", apiKeyHash: "k" });
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: editor,
      role: "editor",
    });
    const storage = memStorage();
    const asEditor = await connect(client, { userId: editor }, false, config, storage);
    const files = { "index.html": "<h1>editor</h1>" };
    const begun = payload(
      await asEditor.callTool({
        name: "begin_deploy",
        arguments: {
          id: cv.id,
          manifest: Object.entries(files).map(([path, content]) => ({
            path,
            hash: sha(content),
            size: new TextEncoder().encode(content).byteLength,
          })),
        },
      }),
    );
    expect(begun.uploadId).toBeTruthy();
    await asEditor.callTool({
      name: "add_files",
      arguments: {
        id: cv.id,
        uploadId: begun.uploadId,
        files: [{ path: "index.html", content: files["index.html"] }],
      },
    });
    // A no-role member cannot finalize the editor's session (nor see the canvas).
    const asNobody = await connect(client, { userId: nobody }, false, config, storage);
    const forged = await asNobody.callTool({
      name: "finalize_deploy",
      arguments: { id: cv.id, uploadId: begun.uploadId },
    });
    expect(isError(forged)).toBe(true);
    expect(text(forged)).toBe("canvas not found");
    const result = payload(
      await asEditor.callTool({
        name: "finalize_deploy",
        arguments: { id: cv.id, uploadId: begun.uploadId },
      }),
    );
    expect(result.version).toBe(1);
    const [v] = await versionsRepository(client).listByCanvas(cv.id);
    expect(v?.createdBy).toBe(editor);
  });
});

describe.each(DIALECTS)("MCP — people-list roles (editor-roles plan U4/U5) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("grant_access with role, list_access roles + ids, set_access_role, owner/guest refusals, team grants", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner@example.com");
    const colleague = await seedUser(client, "colleague@example.com");
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId: owner, slug: "roles", apiKeyHash: "k" });
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "guest",
      email: "g@partner.com",
    });
    const mcp = await connect(client, { userId: owner });

    const granted = payload(
      await mcp.callTool({
        name: "grant_access",
        arguments: { id: cv.id, email: "colleague@example.com", role: "editor" },
      }),
    );
    expect(granted).toMatchObject({ ok: true, status: "granted", role: "editor" });
    expect((await repo.findMemberEntry(cv.id, colleague))?.role).toBe("editor");

    const access = payload(await mcp.callTool({ name: "list_access", arguments: { id: cv.id } }));
    expect(access.entries[0]).toMatchObject({ id: "owner", kind: "owner", role: "owner" });
    const member = access.entries.find((e: { kind: string }) => e.kind === "member");
    expect(member).toMatchObject({ role: "editor", email: "colleague@example.com" });
    expect(member.id).toMatch(/^member:/);
    const guest = access.entries.find((e: { kind: string }) => e.kind === "guest");
    expect(guest).toMatchObject({ role: "viewer" });

    // Demote via set_access_role; the colleague's tools then read not-found.
    const demoted = await mcp.callTool({
      name: "set_access_role",
      arguments: { id: cv.id, entryId: member.id, role: "viewer" },
    });
    expect(isError(demoted)).toBe(false);
    const asColleague = await connect(client, { userId: colleague });
    expect(text(await asColleague.callTool({ name: "get_canvas", arguments: { id: cv.id } }))).toBe(
      "canvas not found",
    );

    // Guest → editor and the owner row are refused with the shared prefixes.
    const guestUp = await mcp.callTool({
      name: "set_access_role",
      arguments: { id: cv.id, entryId: guest.id, role: "editor" },
    });
    expect(text(guestUp)).toMatch(/^GUEST_VIEWER_ONLY: /);
    const ownerUp = await mcp.callTool({
      name: "set_access_role",
      arguments: { id: cv.id, entryId: "owner", role: "viewer" },
    });
    expect(text(ownerUp)).toMatch(/^OWNER_ONLY: /);
    const ownerDel = await mcp.callTool({
      name: "revoke_access",
      arguments: { id: cv.id, entryId: "owner" },
    });
    expect(text(ownerDel)).toMatch(/^OWNER_ONLY: /);

    // A team grant with a role through grant_access (teamId); its member becomes an editor.
    const teams = teamsRepository(client);
    const design = await teams.create({ orgId: null, name: "Design", createdBy: owner });
    await teams.addMember(design.id, colleague);
    const teamGrant = payload(
      await mcp.callTool({
        name: "grant_access",
        arguments: { id: cv.id, teamId: design.id, role: "editor" },
      }),
    );
    expect(teamGrant).toMatchObject({ ok: true, role: "editor" });
    expect(
      isError(await asColleague.callTool({ name: "get_canvas", arguments: { id: cv.id } })),
    ).toBe(false);
    const after = payload(await mcp.callTool({ name: "list_access", arguments: { id: cv.id } }));
    expect(after.entries).toContainEqual(
      expect.objectContaining({ id: `team:${design.id}`, kind: "team", role: "editor" }),
    );
    const both = await mcp.callTool({
      name: "grant_access",
      arguments: { id: cv.id, email: "x@example.com", teamId: design.id },
    });
    expect(text(both)).toMatch(/^INVALID_REQUEST: /);
  });

  it("an editor can manage the people list over MCP (add / promote / remove), never the owner row", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner@example.com");
    const editor = await seedUser(client, "editor@example.com");
    await seedUser(client, "newbie@example.com");
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId: owner, slug: "edit-people", apiKeyHash: "k" });
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: editor,
      role: "editor",
    });
    const mcp = await connect(client, { userId: editor });
    const added = payload(
      await mcp.callTool({
        name: "grant_access",
        arguments: { id: cv.id, email: "newbie@example.com" },
      }),
    );
    expect(added).toMatchObject({ ok: true, status: "granted", role: null });
    const entries = payload(await mcp.callTool({ name: "list_access", arguments: { id: cv.id } }))
      .entries as Array<{ id: string; email: string | null; role: string }>;
    const newbie = entries.find((e) => e.email === "newbie@example.com");
    expect(newbie?.role).toBe("viewer");
    expect(
      isError(
        await mcp.callTool({
          name: "set_access_role",
          arguments: { id: cv.id, entryId: (newbie as { id: string }).id, role: "editor" },
        }),
      ),
    ).toBe(false);
    expect(
      isError(
        await mcp.callTool({
          name: "revoke_access",
          arguments: { id: cv.id, entryId: (newbie as { id: string }).id },
        }),
      ),
    ).toBe(false);
    expect(
      text(
        await mcp.callTool({ name: "revoke_access", arguments: { id: cv.id, entryId: "owner" } }),
      ),
    ).toMatch(/^OWNER_ONLY: /);
  });
});

describe.each(DIALECTS)("MCP — transfer_canvas (editor-roles plan U7) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("owner transfers to an editor; an editor gets OWNER_ONLY; an email is rejected by the schema; a non-editor recipient is NOT_ELIGIBLE", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner@example.com");
    const editor = await seedUser(client, "editor@example.com");
    const viewer = await seedUser(client, "viewer@example.com");
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId: owner, slug: "mcp-xfer", apiKeyHash: "k" });
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: editor,
      role: "editor",
    });
    await repo.addAllowlistEntry({ canvasId: cv.id, principalKind: "member", userId: viewer });

    const asEditor = await connect(client, { userId: editor });
    expect(
      text(
        await asEditor.callTool({
          name: "transfer_canvas",
          arguments: { id: cv.id, toUserId: viewer },
        }),
      ),
    ).toMatch(/^OWNER_ONLY: /);
    const asOwner = await connect(client, { userId: owner });
    const byEmail = await asOwner.callTool({
      name: "transfer_canvas",
      arguments: { id: cv.id, toUserId: "editor@example.com" },
    });
    expect(isError(byEmail)).toBe(true);
    expect(text(byEmail)).toMatch(/toUserId|email|Invalid/i);
    expect(
      text(
        await asOwner.callTool({
          name: "transfer_canvas",
          arguments: { id: cv.id, toUserId: viewer },
        }),
      ),
    ).toMatch(/^NOT_ELIGIBLE: /);
    const ok = payload(
      await asOwner.callTool({
        name: "transfer_canvas",
        arguments: { id: cv.id, toUserId: editor },
      }),
    );
    expect(ok).toMatchObject({ ok: true, previousOwnerEditor: true, publicLinkReverted: false });
    expect((await repo.findById(cv.id))?.ownerId).toBe(editor);
    // The previous owner is an editor now: delete_canvas reads OWNER_ONLY for them.
    expect(
      text(await asOwner.callTool({ name: "delete_canvas", arguments: { id: cv.id } })),
    ).toMatch(/^OWNER_ONLY: /);
  });
});

describe.each(DIALECTS)(
  "MCP — owner entitlements + version creators (editor-roles plan U8) [%s]",
  (dialect) => {
    let client: DbClient;
    afterEach(async () => {
      await client?.close();
    });

    it("AE6 over MCP: update_canvas access=public_link by an editor follows the OWNER's entitlement; guest-AI fields are OWNER_ONLY; list_versions names creators", async () => {
      client = await makeTestDb(dialect);
      const owner = await seedUser(client, "owner@example.com");
      const editor = await seedUser(client, "editor@example.com");
      const users = usersRepository(client);
      const repo = canvasesRepository(client);
      const storage = memStorage();
      const asOwner = await connect(client, { userId: owner }, false, config, storage);
      const made = payload(await asOwner.callTool({ name: "create_canvas", arguments: {} }));
      await asOwner.callTool({
        name: "deploy_canvas",
        arguments: { id: made.id, zipBase64: zip({ "index.html": "<h1>v1</h1>" }) },
      });
      await repo.addAllowlistEntry({
        canvasId: made.id,
        principalKind: "member",
        userId: editor,
        role: "editor",
      });
      const asEditor = await connect(client, { userId: editor }, false, config, storage);

      await users.setPublishPublic(owner, false);
      await users.setPublishPublic(editor, true);
      const gated = await asEditor.callTool({
        name: "update_canvas",
        arguments: { id: made.id, access: "public_link" },
      });
      expect(text(gated)).toMatch(/^PUBLIC_LINK_OWNER_GATED: /);
      await users.setPublishPublic(owner, true);
      await users.setPublishPublic(editor, false);
      const ok = await asEditor.callTool({
        name: "update_canvas",
        arguments: { id: made.id, access: "public_link" },
      });
      expect(isError(ok)).toBe(false);
      expect(payload(ok).access).toBe("public_link");

      expect(
        text(
          await asEditor.callTool({
            name: "update_canvas",
            arguments: { id: made.id, guestAiEnabled: true },
          }),
        ),
      ).toMatch(/^OWNER_ONLY: /);
      expect(
        isError(
          await asOwner.callTool({
            name: "update_canvas",
            arguments: { id: made.id, guestAiEnabled: true },
          }),
        ),
      ).toBe(false);

      // The editor publishes v2 through the draft loop; list_versions names both creators.
      await asEditor.callTool({
        name: "write_draft_file",
        arguments: { id: made.id, path: "index.html", content: "<h1>v2</h1>" },
      });
      const published = await asEditor.callTool({
        name: "publish_draft",
        arguments: { id: made.id },
      });
      expect(isError(published)).toBe(false);
      const listed = payload(
        await asOwner.callTool({ name: "list_versions", arguments: { id: made.id } }),
      );
      expect(
        listed.versions.map(
          (v: { number: number; createdBy: string; createdByName: string | null }) => [
            v.number,
            v.createdBy,
            v.createdByName,
          ],
        ),
      ).toEqual([
        [2, editor, "editor@example.com"],
        [1, owner, "owner@example.com"],
      ]);
    });
  },
);

describe.each(DIALECTS)("MCP — owned-or-edited list (editor-roles plan U9) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("list_canvases returns edited canvases with role + owner, narrows by role, and agrees with the repository list; get_canvas echoes ownerOnlyActs", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner@example.com");
    const editor = await seedUser(client, "editor@example.com");
    const repo = canvasesRepository(client);
    const own = await repo.create({ ownerId: editor, slug: "own", apiKeyHash: "k0" });
    const shared = await repo.create({ ownerId: owner, slug: "shared", apiKeyHash: "k1" });
    await repo.addAllowlistEntry({
      canvasId: shared.id,
      principalKind: "member",
      userId: editor,
      role: "editor",
    });
    const mcp = await connect(client, { userId: editor });
    type Row = { id: string; role: string; owner: { email: string } | null; ownerId: string };
    const all = payload(await mcp.callTool({ name: "list_canvases", arguments: {} }));
    expect(all.total).toBe(2);
    expect(all.canvases.find((c: Row) => c.id === shared.id)).toMatchObject({
      role: "editor",
      ownerId: owner,
      owner: { email: "owner@example.com" },
    });
    expect(all.canvases.find((c: Row) => c.id === own.id)).toMatchObject({ role: "owner" });
    const edited = payload(
      await mcp.callTool({ name: "list_canvases", arguments: { role: "edited" } }),
    );
    expect(edited.canvases.map((c: Row) => c.id)).toEqual([shared.id]);
    const owned = payload(
      await mcp.callTool({ name: "list_canvases", arguments: { role: "owned" } }),
    );
    expect(owned.canvases.map((c: Row) => c.id)).toEqual([own.id]);
    // Parity: the same ids the management list query returns for the same actor.
    const viaRepo = await repo.listForActorFiltered({
      actorId: editor,
      scope: { tenancyActive: false, viewerOrgIds: new Set() },
      limit: 50,
      offset: 0,
    });
    expect(all.canvases.map((c: Row) => c.id).sort()).toEqual(
      viaRepo.items.map((cv) => cv.id).sort(),
    );
    const got = payload(await mcp.callTool({ name: "get_canvas", arguments: { id: shared.id } }));
    expect(got).toMatchObject({
      role: "editor",
      ownerId: owner,
      ownerOnlyActs: ["delete", "transfer", "guest_ai"],
    });
    // Shared discovery over MCP excludes the edited canvas too.
    const sharedOverMcp = payload(
      await mcp.callTool({ name: "list_shared_canvases", arguments: {} }),
    );
    expect((sharedOverMcp.canvases ?? []).map((c: Row) => c.id)).not.toContain(shared.id);
  });
});

describe.each(DIALECTS)("MCP — draft preconditions (editor-roles plan U10) [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("unconditioned write after your own write is fine; after another user's write it is DRAFT_CONFLICT with the fields; the correct expectedHash lands; get_draft / read_draft_file return hashes", async () => {
    client = await makeTestDb(dialect);
    const owner = await seedUser(client, "owner@example.com");
    const editor = await seedUser(client, "editor@example.com");
    const repo = canvasesRepository(client);
    const cv = await repo.create({ ownerId: owner, slug: "mcp-draft", apiKeyHash: "k" });
    await repo.addAllowlistEntry({
      canvasId: cv.id,
      principalKind: "member",
      userId: editor,
      role: "editor",
    });
    const storage = memStorage();
    const asOwner = await connect(client, { userId: owner }, false, config, storage);
    const asEditor = await connect(client, { userId: editor }, false, config, storage);
    const write = (c: typeof asOwner, content: string, expectedHash?: string) =>
      c.callTool({
        name: "write_draft_file",
        arguments: {
          id: cv.id,
          path: "index.html",
          content,
          ...(expectedHash ? { expectedHash } : {}),
        },
      });
    expect(isError(await write(asOwner, "v1"))).toBe(false);
    expect(isError(await write(asOwner, "v2"))).toBe(false); // own follow-up, unconditioned
    const conflict = await write(asEditor, "v3");
    expect(isError(conflict)).toBe(true);
    expect(text(conflict)).toMatch(/^DRAFT_CONFLICT: /);
    expect(text(conflict)).toMatch(/path=index\.html currentHash=[0-9a-f]+ updatedBy=/);
    expect(text(conflict)).toContain("updatedByName=owner@example.com");
    const draft = payload(await asEditor.callTool({ name: "get_draft", arguments: { id: cv.id } }));
    const entry = draft.files.find((f: { path: string }) => f.path === "index.html");
    expect(entry).toMatchObject({ updatedBy: owner, updatedByName: "owner@example.com" });
    expect(typeof entry.hash).toBe("string");
    const read = payload(
      await asEditor.callTool({
        name: "read_draft_file",
        arguments: { id: cv.id, path: "index.html" },
      }),
    );
    expect(read).toMatchObject({ content: "v2", hash: entry.hash, updatedBy: owner });
    expect(isError(await write(asEditor, "v3", entry.hash))).toBe(false);
    // Delete with a stale hash is refused; with the current one it lands.
    const stale = await asEditor.callTool({
      name: "delete_draft_file",
      arguments: { id: cv.id, path: "index.html", expectedHash: entry.hash },
    });
    expect(text(stale)).toMatch(/^DRAFT_CONFLICT: /);
    const now = payload(await asEditor.callTool({ name: "get_draft", arguments: { id: cv.id } }))
      .files[0].hash;
    expect(
      isError(
        await asEditor.callTool({
          name: "delete_draft_file",
          arguments: { id: cv.id, path: "index.html", expectedHash: now },
        }),
      ),
    ).toBe(false);
  });
});

// --- Table-driven parity (editor-roles plan U11, KTD10) -----------------------------------

describe("MCP — tool inventory equals the role table (KTD10)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("every registered tool has a table entry and every table entry is registered", async () => {
    client = await makeTestDb("sqlite");
    const owner = await seedUser(client, "owner@example.com");
    const mcp = await connect(client, { userId: owner });
    const registered = (await mcp.listTools()).tools.map((t) => t.name);
    expect(checkToolInventory(registered)).toEqual({ missingFromTable: [], missingFromServer: [] });
    expect(registered.sort()).toEqual(Object.keys(TOOL_MIN_ROLE).sort());
  });

  it("a tool registered without a table entry (or an entry with no tool) fails the check", () => {
    const keys = Object.keys(TOOL_MIN_ROLE);
    expect(checkToolInventory([...keys, "rogue_tool"]).missingFromTable).toEqual(["rogue_tool"]);
    expect(checkToolInventory(keys.filter((k) => k !== "delete_canvas")).missingFromServer).toEqual(
      ["delete_canvas"],
    );
  });
});

describe.each(DIALECTS)(
  "MCP — role matrix over every canvas-scoped tool (KTD10) [%s]",
  (dialect) => {
    let client: DbClient;
    afterEach(async () => {
      await client?.close();
    });

    type Ctx = { id: string; viewerId: string };
    /** Minimal valid arguments per canvas-scoped tool. Domain refusals (a missing version, a
     *  bad upload handle, an unknown entry id, NOT_ELIGIBLE…) count as ADMITTED: the matrix
     *  only distinguishes "the gate let the role through" from the two role refusals. */
    const ARGS: Record<CanvasToolName, (c: Ctx) => Record<string, unknown>> = {
      get_canvas: ({ id }) => ({ id }),
      list_canvas_connections: ({ id }) => ({ id }),
      update_canvas: ({ id }) => ({ id, title: "matrix" }),
      set_capabilities: ({ id }) => ({ id, kv: true }),
      set_canvas_slug: ({ id }) => ({ id }),
      set_canvas_preview: ({ id }) => ({ id }),
      regenerate_deploy_key: ({ id }) => ({ id }),
      archive_canvas: ({ id }) => ({ id }),
      unarchive_canvas: ({ id }) => ({ id }),
      unpublish_canvas: ({ id }) => ({ id }),
      get_canvas_usage: ({ id }) => ({ id }),
      list_versions: ({ id }) => ({ id }),
      delete_version: ({ id }) => ({ id, version: 99 }),
      rollback_canvas: ({ id }) => ({ id, version: 99 }),
      get_canvas_file: ({ id }) => ({ id }),
      deploy_canvas: ({ id }) => ({ id, zipBase64: zip({ "index.html": "<h1>m</h1>" }) }),
      begin_deploy: ({ id }) => ({
        id,
        manifest: [{ path: "index.html", hash: sha("m"), size: 1 }],
      }),
      add_files: ({ id }) => ({
        id,
        uploadId: "nope",
        files: [{ path: "index.html", content: "m" }],
      }),
      finalize_deploy: ({ id }) => ({ id, uploadId: "nope" }),
      search_people: ({ id }) => ({ context: "canvas", canvasId: id, q: "zz" }),
      list_access: ({ id }) => ({ id }),
      grant_access: ({ id }) => ({ id, email: "matrix-new@example.com" }),
      invite_to_canvas: ({ id }) => ({ id, email: "matrix-new2@example.com" }),
      revoke_access: ({ id }) => ({ id, entryId: "member:nope" }),
      set_access_role: ({ id }) => ({ id, entryId: "member:nope", role: "viewer" }),
      get_draft: ({ id }) => ({ id }),
      read_draft_file: ({ id }) => ({ id, path: "index.html" }),
      write_draft_file: ({ id }) => ({ id, path: "m.txt", content: "m" }),
      delete_draft_file: ({ id }) => ({ id, path: "zz.txt" }),
      rename_draft_file: ({ id }) => ({ id, from: "zz.txt", to: "yy.txt" }),
      publish_draft: ({ id }) => ({ id }),
      restore_draft: ({ id }) => ({ id, version: 99 }),
      delete_canvas: ({ id }) => ({ id }),
      transfer_canvas: ({ id, viewerId }) => ({ id, toUserId: viewerId }),
    };
    type Outcome = "not_found" | "owner_only" | "admitted";
    // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON text payloads
    const classify = (r: any): Outcome => {
      if (!isError(r)) return "admitted";
      const t = text(r);
      if (t === "canvas not found" || t === "not found") return "not_found";
      if (/^OWNER_ONLY: /.test(t)) return "owner_only";
      return "admitted";
    };

    it("owner / editor / viewer / no-role × every canvas-scoped tool → exactly the table's outcome", async () => {
      client = await makeTestDb(dialect);
      const owner = await seedUser(client, "owner@example.com");
      const editor = await seedUser(client, "editor@example.com");
      const viewer = await seedUser(client, "viewer@example.com");
      const nobody = await seedUser(client, "nobody@example.com");
      const repo = canvasesRepository(client);
      const storage = memStorage();
      const clients = {
        owner: await connect(client, { userId: owner }, false, config, storage),
        editor: await connect(client, { userId: editor }, false, config, storage),
        viewer: await connect(client, { userId: viewer }, false, config, storage),
        nobody: await connect(client, { userId: nobody }, false, config, storage),
      };
      const tools = (Object.keys(ARGS) as CanvasToolName[]).sort();
      const failures: string[] = [];
      let n = 0;
      for (const tool of tools) {
        // A fresh canvas per tool so one tool's mutation never shapes another's outcome.
        const cv = await repo.create({
          ownerId: owner,
          slug: `matrix-${n++}`,
          apiKeyHash: `k${n}`,
        });
        await repo.addAllowlistEntry({
          canvasId: cv.id,
          principalKind: "member",
          userId: editor,
          role: "editor",
        });
        await repo.addAllowlistEntry({ canvasId: cv.id, principalKind: "member", userId: viewer });
        const ctx: Ctx = { id: cv.id, viewerId: viewer };
        const min = TOOL_MIN_ROLE[tool];
        const expected: Record<keyof typeof clients, Outcome> = {
          viewer: "not_found",
          nobody: "not_found",
          editor: min === "owner" ? "owner_only" : "admitted",
          owner: "admitted",
        };
        // Rejection paths first, then the editor, then the owner (whose mutation may be last).
        for (const role of ["viewer", "nobody", "editor", "owner"] as const) {
          const res = await clients[role].callTool({ name: tool, arguments: ARGS[tool](ctx) });
          const got = classify(res);
          if (got !== expected[role])
            failures.push(
              `${tool} as ${role}: expected ${expected[role]}, got ${got} (${text(res).slice(0, 80)})`,
            );
        }
      }
      expect(failures).toEqual([]);
    });
  },
);

describe.each(DIALECTS)(
  "MCP — the role is resolved per request (AE12) and AE11 end to end [%s]",
  (dialect) => {
    let client: DbClient;
    afterEach(async () => {
      await client?.close();
    });

    it("AE12: a demoted editor's NEXT call on the same connection reads not found", async () => {
      client = await makeTestDb(dialect);
      const owner = await seedUser(client, "owner@example.com");
      const editor = await seedUser(client, "editor@example.com");
      const repo = canvasesRepository(client);
      const cv = await repo.create({ ownerId: owner, slug: "demote", apiKeyHash: "k" });
      const row = await repo.addAllowlistEntry({
        canvasId: cv.id,
        principalKind: "member",
        userId: editor,
        role: "editor",
      });
      const mcp = await connect(client, { userId: editor });
      expect(isError(await mcp.callTool({ name: "get_canvas", arguments: { id: cv.id } }))).toBe(
        false,
      );
      await repo.setAllowlistRole(cv.id, row.id, "viewer");
      expect(text(await mcp.callTool({ name: "get_canvas", arguments: { id: cv.id } }))).toBe(
        "canvas not found",
      );
      await repo.removeAllowlistEntry(cv.id, row.id);
      expect(
        text(
          await mcp.callTool({
            name: "write_draft_file",
            arguments: { id: cv.id, path: "a.txt", content: "x" },
          }),
        ),
      ).toBe("canvas not found");
    });

    it("AE11: as an editor — list shows role editor → write → publish → versions name the editor → delete/transfer refuse OWNER_ONLY → Shared excludes it", async () => {
      client = await makeTestDb(dialect);
      const owner = await seedUser(client, "owner@example.com");
      const editor = await seedUser(client, "editor@example.com");
      const repo = canvasesRepository(client);
      const cv = await repo.create({ ownerId: owner, slug: "ae11", apiKeyHash: "k" });
      await repo.updateSettings(cv.id, { title: "Roadmap" });
      await repo.addAllowlistEntry({
        canvasId: cv.id,
        principalKind: "member",
        userId: editor,
        role: "editor",
      });
      const storage = memStorage();
      const mcp = await connect(client, { userId: editor }, false, config, storage);

      const listed = payload(await mcp.callTool({ name: "list_canvases", arguments: {} }));
      expect(listed.canvases.find((c: { id: string }) => c.id === cv.id)).toMatchObject({
        role: "editor",
        owner: { email: "owner@example.com" },
      });
      expect(
        isError(
          await mcp.callTool({
            name: "write_draft_file",
            arguments: { id: cv.id, path: "index.html", content: "<h1>by editor</h1>" },
          }),
        ),
      ).toBe(false);
      const published = payload(
        await mcp.callTool({ name: "publish_draft", arguments: { id: cv.id } }),
      );
      expect(published.version).toBe(1);
      const versions = payload(
        await mcp.callTool({ name: "list_versions", arguments: { id: cv.id } }),
      );
      expect(versions.versions[0]).toMatchObject({
        createdBy: editor,
        createdByName: "editor@example.com",
      });
      expect(text(await mcp.callTool({ name: "delete_canvas", arguments: { id: cv.id } }))).toMatch(
        /^OWNER_ONLY: /,
      );
      expect(
        text(
          await mcp.callTool({
            name: "transfer_canvas",
            arguments: { id: cv.id, toUserId: owner },
          }),
        ),
      ).toMatch(/^OWNER_ONLY: /);
      const shared = payload(await mcp.callTool({ name: "list_shared_canvases", arguments: {} }));
      expect((shared.canvases ?? []).map((c: { id: string }) => c.id)).not.toContain(cv.id);
    });
  },
);

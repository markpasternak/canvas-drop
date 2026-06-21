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
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { screenshotsRepository } from "../db/repositories/screenshots.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { uploadSessionsRepository } from "../db/repositories/upload-sessions.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { draftService } from "../draft/service.js";
import { memStorage } from "../storage/mem.js";
import { teamsService } from "../teams/service.js";
import { uploadService } from "../upload/service.js";
import { buildMcpServer } from "./server.js";

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
  caller: { userId: string; orgIds?: Set<string>; tenancyActive?: boolean },
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
        audit,
      }),
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
    {
      userId: caller.userId,
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

  it("list_shared_with_teams surfaces a team canvas to a teammate, not the owner", async () => {
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
    // The owner does NOT see their own canvas in the shared-with-teams read.
    expect(
      payload(await ownerMcp.callTool({ name: "list_shared_with_teams", arguments: {} })).canvases,
    ).toHaveLength(0);
    // The teammate does.
    const mateMcp = await connectMember(mateId, org.id);
    const { canvases } = payload(
      await mateMcp.callTool({ name: "list_shared_with_teams", arguments: {} }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: JSON payload
    expect(canvases.map((c: any) => c.id)).toContain(cv.id);
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
});

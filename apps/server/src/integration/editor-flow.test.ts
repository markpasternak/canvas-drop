import { Buffer } from "node:buffer";
import { type Config, loadConfig } from "@canvas-drop/shared";
import { zipSync } from "fflate";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuditLog } from "../audit/audit-log.js";
import { devStrategy } from "../auth/dev.js";
import { sessionService } from "../auth/session.js";
import type { DbClient } from "../db/factory.js";
import { auditRepository } from "../db/repositories/audit.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { draftsRepository } from "../db/repositories/drafts.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { versionsRepository } from "../db/repositories/versions.js";
import { makeTestDb } from "../db/testing.js";
import { deployEngine } from "../deploy/engine.js";
import { memStorage } from "../storage/mem.js";

/**
 * End-to-end editor flows (M5) through the full role-routed app: edit → publish →
 * serve (F1), restore an old version (F2), and an agent deploy under a held draft
 * (F3/AE5). Dev mode auto-authenticates as the owner.
 */
const silent = pino({ level: "silent" });
const config: Config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const enc = (s: string) => new TextEncoder().encode(s);
const H = { host: "localhost:3000" } as const;
const jsonOf = <T>(r: Response) => r.json() as Promise<T>;

describe("editor flows (e2e)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  function makeApp() {
    const canvases = canvasesRepository(client);
    const versions = versionsRepository(client);
    const drafts = draftsRepository(client);
    const storage = memStorage();
    return buildApp({
      config,
      db: client,
      rootLogger: silent,
      strategy: devStrategy(config),
      users: usersRepository(client),
      canvases,
      versions,
      drafts,
      storage,
      engine: deployEngine({ config, canvases, versions, drafts, storage, log: silent }),
      audit: createAuditLog(auditRepository(client), silent),
      sessionSvc: sessionService(config, sessionsRepository(client)),
      peerIp: () => "127.0.0.1",
    });
  }

  async function createCanvas(app: ReturnType<typeof buildApp>) {
    return jsonOf<{ id: string; slug: string; apiKey: string }>(
      await app.request("/api/canvases", {
        method: "POST",
        headers: { ...H, "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
        body: "{}",
      }),
    );
  }

  const putFile = (app: ReturnType<typeof buildApp>, id: string, path: string, body: string) =>
    app.request(`/api/canvases/${id}/draft/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { ...H, "Sec-Fetch-Site": "same-origin" },
      body,
    });

  const publish = (app: ReturnType<typeof buildApp>, id: string) =>
    app.request(`/api/canvases/${id}/publish`, {
      method: "POST",
      headers: { ...H, "Sec-Fetch-Site": "same-origin" },
    });

  it("F1: edit the draft → publish → the live canvas serves the new bytes", async () => {
    client = await makeTestDb("sqlite");
    const app = makeApp();
    const { id, slug } = await createCanvas(app);

    await putFile(app, id, "index.html", "<h1>v1</h1>");
    const pub1 = await publish(app, id);
    expect(pub1.status).toBe(200);
    expect((await jsonOf<{ version: number }>(pub1)).version).toBe(1);

    const live1 = await app.request(`/c/${slug}/index.html`, { headers: H });
    expect(live1.status).toBe(200);
    expect(await live1.text()).toContain("v1");

    // Edit again + publish v2 → live updates.
    await putFile(app, id, "index.html", "<h1>v2</h1>");
    expect((await jsonOf<{ version: number }>(await publish(app, id))).version).toBe(2);
    expect(await (await app.request(`/c/${slug}/`, { headers: H })).text()).toContain("v2");

    // Version history shows two published versions.
    const hist = await jsonOf<{ versions: Array<{ number: number }> }>(
      await app.request(`/api/canvases/${id}/versions`, { headers: H }),
    );
    expect(hist.versions.map((v) => v.number)).toEqual([2, 1]);
  });

  it("F2: restore an old version into the draft, edit, and publish a new version", async () => {
    client = await makeTestDb("sqlite");
    const app = makeApp();
    const { id, slug } = await createCanvas(app);

    await putFile(app, id, "index.html", "<h1>one</h1>");
    await publish(app, id); // v1
    await putFile(app, id, "index.html", "<h1>two</h1>");
    await publish(app, id); // v2

    // Restore v1 into the draft, then publish → v3 carries v1's content.
    const restored = await app.request(`/api/canvases/${id}/restore`, {
      method: "POST",
      headers: { ...H, "Sec-Fetch-Site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(restored.status).toBe(200);
    expect((await jsonOf<{ version: number }>(await publish(app, id))).version).toBe(3);
    expect(await (await app.request(`/c/${slug}/`, { headers: H })).text()).toContain("one");
  });

  it("F3/AE5: an agent deploy under a held draft goes live and flags the draft stale", async () => {
    client = await makeTestDb("sqlite");
    const app = makeApp();
    const { id, slug, apiKey } = await createCanvas(app);

    // Publish v1, then start an unpublished draft edit.
    await putFile(app, id, "index.html", "<h1>v1</h1>");
    await publish(app, id);
    await putFile(app, id, "index.html", "<h1>my unpublished draft</h1>");

    // Agent deploys directly via the Bearer-key API.
    const zip = Buffer.from(zipSync({ "index.html": enc("<h1>agent</h1>") }));
    const deploy = await app.request(`/v1/canvases/${id}/deploy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: zip,
    });
    expect(deploy.status).toBe(200);

    // The agent's version is live...
    expect(await (await app.request(`/c/${slug}/`, { headers: H })).text()).toContain("agent");
    // ...and the draft is preserved but flagged stale.
    const draft = await jsonOf<{ stale: boolean; files: Array<{ path: string }> }>(
      await app.request(`/api/canvases/${id}/draft`, { headers: H }),
    );
    expect(draft.stale).toBe(true);
    expect(draft.files.some((f) => f.path === "index.html")).toBe(true);

    // The preview still shows the owner's draft bytes, not the agent's live version.
    const preview = await app.request(`/api/canvases/${id}/preview/`, { headers: H });
    expect(await preview.text()).toContain("my unpublished draft");
  });
});

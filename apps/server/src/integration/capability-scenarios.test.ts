import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { DbClient } from "../db/factory.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import {
  ADMIN,
  AI_MODEL,
  connectMcp,
  DOMAIN,
  enc,
  GUEST_EMAIL,
  type Harness,
  jsonOf,
  MEMBER,
  makeHarness,
  mcpIsError,
  mcpPayload,
  OTHER,
  OWNER,
  type ServerHandle,
  scenarioConfig,
  zip,
} from "./scenario-harness.js";

/**
 * Capability acceptance scenarios — ten realistic, persona-driven journeys that
 * together exercise every major capability through the REAL composed app
 * (`buildApp`). Each `it` is one scenario; its assertions are its pass/fail
 * oracle. Parametrized over both dialects (sqlite + pglite). See the spec +
 * evaluation method in `docs/qa/2026-06-20-capability-scenarios.md`.
 */

const sha = (s: string) => createHash("sha256").update(enc(s)).digest("hex");

/** Pull a single `name=value` cookie pair out of a response's Set-Cookie header. */
function cookiePair(res: Response, name: string): string | null {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${name}=([^;]+)`).exec(sc);
  return m ? `${name}=${m[1]}` : null;
}

const bearer = (h: Harness, key: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${key}`,
  host: h.baseHost,
  ...extra,
});

/** Raw draft-file PUT (the editor writes raw bytes, not JSON). */
const putDraft = (h: Harness, email: string, id: string, path: string, body: string) =>
  h.app.request(`/api/canvases/${id}/draft/file?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: h.headers(email, { "Sec-Fetch-Site": "same-origin" }),
    body,
  });

// ── realtime WebSocket client (scenario 7) ─────────────────────────────────────
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WsClient {
  sock: WebSocket;
  messages: Array<Record<string, unknown>>;
  opened: Promise<void>;
  closed: Promise<{ code: number }>;
  send(obj: unknown): void;
  waitFor(
    pred: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ): Promise<Record<string, unknown>>;
}

function connectWs(port: number, slug: string, headers: Record<string, string> = {}): WsClient {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/v1/c/${slug}/realtime`, { headers });
  const messages: Array<Record<string, unknown>> = [];
  sock.on("message", (d) => messages.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number }>((r) => sock.on("close", (code) => r({ code })));
  const opened = new Promise<void>((resolve, reject) => {
    sock.once("open", () => resolve());
    sock.once("unexpected-response", (_req, res) =>
      reject(Object.assign(new Error("handshake refused"), { status: res.statusCode })),
    );
    sock.once("error", (e) => reject(e));
  });
  return {
    sock,
    messages,
    opened,
    closed,
    send: (obj) => sock.send(JSON.stringify(obj)),
    async waitFor(pred, ms = 2000) {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const m = messages.find(pred);
        if (m) return m;
        await delay(15);
      }
      throw new Error("timeout waiting for realtime message");
    },
  };
}

describe.each(DIALECTS)("capability scenarios [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  // ── S1 — PM ships a pasted prototype (lifecycle + hosting) ───────────────────
  it("S1: create → paste-publish → serve → versions → archive/unarchive → delete", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client);

    // Create generates a readable slug + a once-shown cd_ key; only the hash is stored.
    const createRes = await h.SEND(OWNER, "POST", "/api/canvases", { title: "Launch demo" });
    expect(createRes.status).toBe(201);
    const created = await jsonOf<{ id: string; slug: string; apiKey: string }>(createRes);
    expect(created.slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{13}$/);
    expect(created.apiKey).toMatch(/^cd_/);
    expect((await h.repos.canvases.findById(created.id))?.apiKeyHash).not.toBe(created.apiKey);

    // Paste-HTML publishes a live v1.
    const pasteRes = await h.SEND(OWNER, "POST", "/api/canvases/paste", {
      html: "<!doctype html><html><body><h1>Launch</h1></body></html>",
    });
    expect(pasteRes.status).toBe(201);
    const cv = await jsonOf<{ id: string; slug: string }>(pasteRes);

    // Static serving: index.html serves with a text/html content type…
    const index = await h.GET(OWNER, `/c/${cv.slug}/index.html`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("Launch");
    // …and the canvas root falls back to index.html.
    const root = await h.GET(OWNER, `/c/${cv.slug}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("Launch");

    // Version metadata is recorded (number + at least one of fileCount/size).
    const versions = await jsonOf<{
      versions: Array<{
        number: number;
        fileCount?: number;
        sizeBytes?: number;
        totalBytes?: number;
      }>;
    }>(await h.GET(OWNER, `/api/canvases/${cv.id}/versions`));
    expect(versions.versions).toHaveLength(1);
    const v1 = versions.versions[0];
    expect(v1?.number).toBe(1);
    expect(
      typeof v1?.fileCount === "number" ||
        typeof v1?.sizeBytes === "number" ||
        typeof v1?.totalBytes === "number",
    ).toBe(true);

    // Archive moves it out of the active list and into ?scope=archived; unarchive reverses.
    expect((await h.SEND(OWNER, "POST", `/api/canvases/${cv.id}/archive`)).status).toBe(200);
    const active = await jsonOf<{ canvases: { id: string }[] }>(
      await h.GET(OWNER, "/api/canvases"),
    );
    expect(active.canvases.map((c) => c.id)).not.toContain(cv.id);
    const archived = await jsonOf<{ canvases: { id: string }[] }>(
      await h.GET(OWNER, "/api/canvases?scope=archived"),
    );
    expect(archived.canvases.map((c) => c.id)).toContain(cv.id);
    expect((await h.SEND(OWNER, "POST", `/api/canvases/${cv.id}/unarchive`)).status).toBe(200);

    // Soft-delete removes it from the owner list and stops serving the URL.
    expect((await h.SEND(OWNER, "DELETE", `/api/canvases/${cv.id}`)).status).toBe(200);
    const afterDelete = await jsonOf<{ canvases: { id: string }[] }>(
      await h.GET(OWNER, "/api/canvases"),
    );
    expect(afterDelete.canvases.map((c) => c.id)).not.toContain(cv.id);
    expect((await h.GET(OWNER, `/c/${cv.slug}/`)).status).toBe(404);
  });

  // ── S2 — Designer iterates in the editor (draft / publish version model) ─────
  it("S2: edit draft (no version) → publish v1/v2 → history → rollback → restore", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client);
    const cv = await jsonOf<{ id: string; slug: string }>(
      await h.SEND(OWNER, "POST", "/api/canvases", { title: "Interaction concept" }),
    );

    // Edit the draft (three assets) — this creates NO version.
    await putDraft(h, OWNER, cv.id, "index.html", "<h1>v1</h1>");
    await putDraft(h, OWNER, cv.id, "style.css", "h1{color:red}");
    await putDraft(h, OWNER, cv.id, "app.js", "console.log(1)");
    const draft = await jsonOf<{ files: { path: string }[] }>(
      await h.GET(OWNER, `/api/canvases/${cv.id}/draft`),
    );
    expect(draft.files.map((f) => f.path).sort()).toEqual(["app.js", "index.html", "style.css"]);
    const noVersions = await jsonOf<{ versions: unknown[] }>(
      await h.GET(OWNER, `/api/canvases/${cv.id}/versions`),
    );
    expect(noVersions.versions).toHaveLength(0);
    // The draft preview serves the unpublished bytes.
    expect(await (await h.GET(OWNER, `/api/canvases/${cv.id}/preview/`)).text()).toContain("v1");

    // Publish v1 → the live URL serves all three assets with correct content types.
    expect(
      (
        await jsonOf<{ version: number }>(
          await h.SEND(OWNER, "POST", `/api/canvases/${cv.id}/publish`),
        )
      ).version,
    ).toBe(1);
    const html = await h.GET(OWNER, `/c/${cv.slug}/index.html`);
    expect(await html.text()).toContain("v1");
    expect((await h.GET(OWNER, `/c/${cv.slug}/style.css`)).headers.get("content-type")).toContain(
      "css",
    );
    expect((await h.GET(OWNER, `/c/${cv.slug}/app.js`)).headers.get("content-type")).toMatch(
      /javascript/,
    );

    // Edit + publish v2 → live updates; history is newest-first [2, 1].
    await putDraft(h, OWNER, cv.id, "index.html", "<h1>v2</h1>");
    expect(
      (
        await jsonOf<{ version: number }>(
          await h.SEND(OWNER, "POST", `/api/canvases/${cv.id}/publish`),
        )
      ).version,
    ).toBe(2);
    expect(await (await h.GET(OWNER, `/c/${cv.slug}/`)).text()).toContain("v2");
    const hist = await jsonOf<{ versions: { number: number }[] }>(
      await h.GET(OWNER, `/api/canvases/${cv.id}/versions`),
    );
    expect(hist.versions.map((v) => v.number)).toEqual([2, 1]);

    // One-click rollback to v1 → the live URL serves v1 again.
    expect(
      (await h.SEND(OWNER, "POST", `/api/canvases/${cv.id}/rollback`, { version: 1 })).status,
    ).toBe(200);
    expect(await (await h.GET(OWNER, `/c/${cv.slug}/`)).text()).toContain("v1");

    // Restore v1 into the draft and publish → v3 carries v1's content.
    expect(
      (await h.SEND(OWNER, "POST", `/api/canvases/${cv.id}/restore`, { version: 1 })).status,
    ).toBe(200);
    expect(
      (
        await jsonOf<{ version: number }>(
          await h.SEND(OWNER, "POST", `/api/canvases/${cv.id}/publish`),
        )
      ).version,
    ).toBe(3);
    expect(await (await h.GET(OWNER, `/c/${cv.slug}/`)).text()).toContain("v1");
  });

  // ── S3 — Engineer ships via the deploy API + staged upload (agent contract) ──
  it("S3: Bearer deploy=live → read-back → isolation/validation → staged upload → deploy-under-draft", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client);
    const a = await jsonOf<{ id: string; slug: string; apiKey: string }>(
      await h.SEND(OWNER, "POST", "/api/canvases", {}),
    );
    const b = await jsonOf<{ id: string; apiKey: string }>(
      await h.SEND(OWNER, "POST", "/api/canvases", {}),
    );

    // deploy = live; machine-readable result.
    const deployed = await h.app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: bearer(h, a.apiKey),
      body: zip({ "index.html": "<h1>api v1</h1>", "style.css": "body{}" }),
    });
    expect(deployed.status).toBe(200);
    const result = await jsonOf<{
      url: string;
      version: number;
      fileCount: number;
      warnings: string[];
    }>(deployed);
    expect(result).toMatchObject({ version: 1, fileCount: 2 });
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(await (await h.GET(OWNER, `/c/${a.slug}/`)).text()).toContain("api v1");

    // Read back the live version to verify (listing + raw bytes with matching hash).
    const listing = await jsonOf<{ version: number; files: { path: string }[] }>(
      await h.app.request(`/v1/canvases/${a.id}/files`, { headers: bearer(h, a.apiKey) }),
    );
    expect(listing.version).toBe(1);
    expect(listing.files.map((f) => f.path).sort()).toEqual(["index.html", "style.css"]);
    const raw = await h.app.request(`/v1/canvases/${a.id}/files?path=index.html`, {
      headers: bearer(h, a.apiKey),
    });
    expect(raw.headers.get("etag")).toBe(`"${sha("<h1>api v1</h1>")}"`);

    // Validation + isolation: bad key → 401; A's key on B → 403; zip-slip → 400.
    expect(
      (
        await h.app.request(`/v1/canvases/${a.id}/deploy`, {
          method: "PUT",
          headers: bearer(h, "cd_bogus"),
          body: zip({ "index.html": "x" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.app.request(`/v1/canvases/${b.id}/deploy`, {
          method: "PUT",
          headers: bearer(h, a.apiKey),
          body: zip({ "index.html": "x" }),
        })
      ).status,
    ).toBe(403);
    const slip = await h.app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: bearer(h, a.apiKey),
      body: zip({ "../escape.txt": "x", "index.html": "ok" }),
    });
    expect(slip.status).toBe(400);
    expect((await jsonOf<{ code: string }>(slip)).code).toBe("ZIP_SLIP_REJECTED");

    // Content-addressed staged upload: begin → PUT blobs → finalize publishes v2.
    const files = { "index.html": "<h1>staged</h1>", "app.js": "console.log(2)" };
    const manifest = Object.entries(files).map(([path, content]) => ({
      path,
      hash: sha(content),
      size: enc(content).byteLength,
    }));
    const begun = await jsonOf<{ uploadId: string; missingHashes: string[] }>(
      await h.app.request(`/v1/canvases/${a.id}/uploads`, {
        method: "POST",
        headers: bearer(h, a.apiKey, { "content-type": "application/json" }),
        body: JSON.stringify({ manifest }),
      }),
    );
    expect(begun.missingHashes).toHaveLength(2);
    for (const [, content] of Object.entries(files)) {
      const put = await h.app.request(
        `/v1/canvases/${a.id}/uploads/${begun.uploadId}/blobs/${sha(content)}`,
        { method: "PUT", headers: bearer(h, a.apiKey), body: enc(content) },
      );
      expect(put.status).toBe(204);
    }
    const finalize = await h.app.request(
      `/v1/canvases/${a.id}/uploads/${begun.uploadId}/finalize`,
      {
        method: "POST",
        headers: bearer(h, a.apiKey, { "content-type": "application/json" }),
      },
    );
    // A new live version is published — its number may skip past the rejected
    // zip-slip attempt above (pending rows consume a number), so assert "newer".
    const stagedVersion = (await jsonOf<{ version: number }>(finalize)).version;
    expect(stagedVersion).toBeGreaterThan(result.version);
    expect(await (await h.GET(OWNER, `/c/${a.slug}/`)).text()).toContain("staged");

    // An agent deploy under a held editor draft goes live AND flags the draft stale.
    await putDraft(h, OWNER, a.id, "index.html", "<h1>my unpublished draft</h1>");
    const agent = await h.app.request(`/v1/canvases/${a.id}/deploy`, {
      method: "PUT",
      headers: bearer(h, a.apiKey),
      body: zip({ "index.html": "<h1>agent live</h1>" }),
    });
    expect(agent.status).toBe(200);
    expect(await (await h.GET(OWNER, `/c/${a.slug}/`)).text()).toContain("agent live");
    const heldDraft = await jsonOf<{ stale: boolean }>(
      await h.GET(OWNER, `/api/canvases/${a.id}/draft`),
    );
    expect(heldDraft.stale).toBe(true);
    expect(await (await h.GET(OWNER, `/api/canvases/${a.id}/preview/`)).text()).toContain(
      "my unpublished draft",
    );
  });

  // ── S4 — Ops builds a form-backed tool (KV primitive) ────────────────────────
  it("S4: KV shared set/get/delete/list/increment + per-viewer scope + capability toggle + metering", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client);
    const cv = await jsonOf<{ id: string; slug: string }>(
      await h.SEND(OWNER, "POST", "/api/canvases/paste", { html: "<h1>form</h1>" }),
    );
    await h.repos.canvases.updateCapabilities(cv.id, { backendEnabled: true });
    await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, { access: "whole_org" });
    const kv = (slug: string) => `/v1/c/${slug}/kv`;

    // Shared set/get/delete round-trip.
    expect((await h.SEND(OWNER, "PUT", `${kv(cv.slug)}/greeting`, { hi: 1 })).status).toBe(200);
    expect(await (await h.GET(OWNER, `${kv(cv.slug)}/greeting`)).json()).toEqual({
      value: { hi: 1 },
    });
    expect((await h.SEND(OWNER, "DELETE", `${kv(cv.slug)}/greeting`)).status).toBe(200);
    expect((await h.GET(OWNER, `${kv(cv.slug)}/greeting`)).status).toBe(404);

    // list with prefix + pagination.
    for (const k of ["a:1", "a:2", "b:1"]) await h.SEND(OWNER, "PUT", `${kv(cv.slug)}/${k}`, 0);
    const page = await jsonOf<{ entries: { key: string }[]; nextCursor: string | null }>(
      await h.GET(OWNER, `${kv(cv.slug)}?prefix=a:&limit=1`),
    );
    expect(page.entries.map((e) => e.key)).toEqual(["a:1"]);
    expect(page.nextCursor).toBe("a:1");

    // Atomic increment returns the running total.
    expect(
      (
        await jsonOf<{ value: number }>(
          await h.SEND(OWNER, "POST", `${kv(cv.slug)}/votes/increment`, { by: 1 }),
        )
      ).value,
    ).toBe(1);
    expect(
      (
        await jsonOf<{ value: number }>(
          await h.SEND(OWNER, "POST", `${kv(cv.slug)}/votes/increment`, { by: 4 }),
        )
      ).value,
    ).toBe(5);

    // Per-viewer kv.user scope: two members never see each other's value.
    await h.SEND(OWNER, "PUT", `${kv(cv.slug)}/user/theme`, "dark");
    await h.SEND(MEMBER, "PUT", `${kv(cv.slug)}/user/theme`, "light");
    expect(await (await h.GET(OWNER, `${kv(cv.slug)}/user/theme`)).json()).toEqual({
      value: "dark",
    });
    expect(await (await h.GET(MEMBER, `${kv(cv.slug)}/user/theme`)).json()).toEqual({
      value: "light",
    });

    // Capability management: toggling KV off → 403; back on → works.
    expect(
      (await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/capabilities`, { kv: false })).status,
    ).toBe(200);
    const off = await h.GET(OWNER, `${kv(cv.slug)}/greeting`);
    expect(off.status).toBe(403);
    expect((await jsonOf<{ code: string }>(off)).code).toBe("CAPABILITY_DISABLED");
    expect(
      (await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/capabilities`, { kv: true })).status,
    ).toBe(200);
    expect((await h.SEND(OWNER, "PUT", `${kv(cv.slug)}/again`, 1)).status).toBe(200);

    // Writes are metered.
    expect((await h.repos.usage.countByType(cv.id, null)).kv_op).toBeGreaterThan(0);
  });

  // ── S5 — File-intake tool (files primitive) ──────────────────────────────────
  it("S5: file upload → list metadata → inert download → delete + metering", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client);
    const cv = await jsonOf<{ id: string; slug: string }>(
      await h.SEND(OWNER, "POST", "/api/canvases", {}),
    );
    await h.repos.canvases.updateCapabilities(cv.id, { backendEnabled: true });

    // Upload via multipart/form-data (field `file`).
    const form = new FormData();
    form.set("file", new File(["name,score\nada,9"], "data.csv", { type: "text/csv" }));
    const up = await h.app.request(`/v1/c/${cv.slug}/files`, {
      method: "POST",
      headers: h.headers(OWNER, { "Sec-Fetch-Site": "same-origin" }),
      body: form,
    });
    expect(up.status).toBe(201);
    const file = await jsonOf<{ id: string; name: string; size: number; url: string }>(up);
    expect(file).toMatchObject({ name: "data.csv" });
    expect(file.size).toBeGreaterThan(0);

    // List returns the file with metadata.
    const list = await jsonOf<{ files: { id: string; name: string }[] }>(
      await h.GET(OWNER, `/v1/c/${cv.slug}/files`),
    );
    expect(list.files.map((f) => f.name)).toContain("data.csv");

    // Download serves the exact bytes as inert (nosniff) content.
    const dl = await h.GET(OWNER, file.url);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await dl.text()).toContain("ada,9");

    // Delete → the file then 404s.
    expect((await h.SEND(OWNER, "DELETE", `/v1/c/${cv.slug}/files/${file.id}`)).status).toBe(200);
    expect((await h.GET(OWNER, file.url)).status).toBe(404);

    // File ops are metered.
    expect((await h.repos.usage.countByType(cv.id, null)).file_op).toBeGreaterThan(0);
  });

  // ── S6 — AI summarizer canvas (AI primitive) ─────────────────────────────────
  it("S6: AI stream (SSE) → metering → allowlist reject → quota exceeded → no key leak", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client);
    const cv = await jsonOf<{ id: string; slug: string }>(
      await h.SEND(OWNER, "POST", "/api/canvases", {}),
    );
    await h.repos.canvases.updateCapabilities(cv.id, { backendEnabled: true });

    // Streamed chat: delta frames concatenate to the model output, then a done frame.
    const res = await h.SEND(OWNER, "POST", `/v1/c/${cv.slug}/ai/chat`, {
      model: AI_MODEL,
      messages: [{ role: "user", content: "summarize" }],
      maxTokens: 64,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).not.toContain("sk-test-not-a-real-key"); // the provider key never leaks
    const frames = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data:"))
      .map(
        (l) =>
          JSON.parse(l.slice("data:".length).trim()) as {
            type: string;
            text?: string;
            usage?: { outputTokens: number };
            cost?: number;
          },
      );
    expect(
      frames
        .filter((f) => f.type === "delta")
        .map((f) => f.text)
        .join(""),
    ).toBe("Hello, world.");
    const done = frames.find((f) => f.type === "done");
    expect(done?.usage?.outputTokens).toBe(8);
    expect(typeof done?.cost).toBe("number");

    // Usage is metered (owner usage panel reflects the call).
    const usage = await jsonOf<{ aiCalls: number; aiTokens: number }>(
      await h.GET(OWNER, `/api/canvases/${cv.id}/usage`),
    );
    expect(usage.aiCalls).toBeGreaterThanOrEqual(1);
    expect(usage.aiTokens).toBeGreaterThan(0);

    // A model not on the allowlist is rejected before any stream.
    const denied = await h.SEND(OWNER, "POST", `/v1/c/${cv.slug}/ai/chat`, {
      model: "gpt-4o-not-allowed",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(denied.status).toBe(403);
    expect((await jsonOf<{ code: string }>(denied)).code).toBe("MODEL_NOT_ALLOWED");

    // Seed spend past the canvas monthly cap → the next call is quota-rejected.
    const ownerUser = await h.repos.users.findByEmail(OWNER);
    await h.repos.aiUsage.record({
      canvasId: cv.id,
      userId: ownerUser?.id ?? "",
      provider: "anthropic",
      model: AI_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 100,
    });
    const over = await h.SEND(OWNER, "POST", `/v1/c/${cv.slug}/ai/chat`, {
      model: AI_MODEL,
      messages: [{ role: "user", content: "again" }],
    });
    expect(over.status).toBe(429);
    expect((await jsonOf<{ code: string }>(over)).code).toBe("QUOTA_EXCEEDED");
  });

  // ── S7 — Live poll / multiplayer (realtime primitive) ────────────────────────
  it("S7: realtime pub/sub + presence + cross-canvas isolation + revoke-drops-socket + capability-off", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client);
    const owner = await h.repos.users.upsert({
      providerSub: `dev:${OWNER}`,
      email: OWNER,
      name: "owner",
      isAdmin: false,
    });
    const seed = async (slug: string, capRealtime = true) => {
      const c = await h.repos.canvases.create({
        ownerId: owner.id,
        slug,
        apiKeyHash: `h-${slug}`,
        backendEnabled: true,
      });
      await h.repos.canvases.updateSettings(c.id, { access: "whole_org" });
      if (!capRealtime) await h.repos.canvases.updateCapabilities(c.id, { realtime: false });
      return c;
    };
    const a = await seed("room-a");
    await seed("room-b");
    await seed("room-c", false);

    const server: ServerHandle = await h.listen();
    const sockets: WebSocket[] = [];
    const track = (c: WsClient) => {
      sockets.push(c.sock);
      return c;
    };
    try {
      // pub/sub + presence: two members in room-a.
      const alice = track(connectWs(server.port, "room-a", { "x-test-user": MEMBER }));
      const bob = track(connectWs(server.port, "room-a", { "x-test-user": OTHER }));
      await Promise.all([alice.opened, bob.opened]);
      alice.send({ type: "subscribe", channel: "poll" });
      await alice.waitFor((m) => m.type === "subscribed");
      bob.send({ type: "subscribe", channel: "poll" });
      await bob.waitFor((m) => m.type === "subscribed");
      // alice sees bob join + a presence snapshot listing both members.
      await alice.waitFor((m) => m.type === "join");
      const presence = bob.messages.find((m) => m.type === "presence");
      expect((presence?.users as Array<{ id: string }>).length).toBe(2);
      // a publish fans out to subscribers.
      alice.send({ type: "publish", channel: "poll", event: "vote", data: { n: 1 } });
      const got = await bob.waitFor((m) => m.type === "message");
      expect(got).toMatchObject({ event: "vote", data: { n: 1 } });

      // cross-canvas isolation: a publish in room-a never reaches room-b.
      const onB = track(connectWs(server.port, "room-b", { "x-test-user": MEMBER }));
      await onB.opened;
      onB.send({ type: "subscribe", channel: "poll" });
      await onB.waitFor((m) => m.type === "subscribed");
      alice.send({ type: "publish", channel: "poll", event: "leak", data: 1 });
      await delay(100);
      expect(onB.messages.some((m) => m.type === "message")).toBe(false);

      // revoke-drops-socket: un-sharing room-a closes the non-owner socket (4401).
      await h.repos.canvases.updateSettings(a.id, { access: "private" });
      await h.hub.revalidateCanvas(a.id);
      expect((await alice.closed).code).toBe(4401);

      // capability-off: room-c upgrades then closes 4403 with a CAPABILITY_DISABLED frame.
      const onC = track(connectWs(server.port, "room-c", { "x-test-user": MEMBER }));
      await onC.opened;
      expect((await onC.closed).code).toBe(4403);
      expect(onC.messages.some((m) => m.code === "CAPABILITY_DISABLED")).toBe(true);
    } finally {
      for (const s of sockets) s.close();
      await server.close();
    }
  });

  // ── S8 — Sharing ladder, auth-delegated Add person & identity ───────────────
  it("S8: access ladder + me(member) + auth-delegated Add person + password + revoke + expiry + public gating", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client, {
      config: scenarioConfig({
        CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: `${DOMAIN},partner.test`,
      }),
    });
    const cv = await jsonOf<{ id: string; slug: string }>(
      await h.SEND(OWNER, "POST", "/api/canvases/paste", { html: "<h1>secret</h1>" }),
    );
    await h.repos.canvases.updateCapabilities(cv.id, { backendEnabled: true });
    const content = `/c/${cv.slug}/`;

    // private: a non-owner member → 404 (no existence leak); the owner always reaches it.
    expect((await h.GET(MEMBER, content)).status).toBe(404);
    expect((await h.GET(OWNER, content)).status).toBe(200);

    // whole_org: any member reaches it; me() → kind "member".
    await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, { access: "whole_org" });
    expect((await h.GET(MEMBER, content)).status).toBe(200);
    const meMember = await jsonOf<{ kind: string; email: string }>(
      await h.GET(MEMBER, `/v1/c/${cv.slug}/me`),
    );
    expect(meMember).toMatchObject({ kind: "member", email: MEMBER });

    // specific_people + auth-delegated Add person.
    await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, { access: "specific_people" });
    const add = await h.SEND(OWNER, "POST", `/api/canvases/${cv.id}/allowlist`, {
      email: GUEST_EMAIL,
    });
    expect(add.status).toBe(200);
    expect((await jsonOf<{ status: string }>(add)).status).toBe("pending");
    expect(h.mailer.sent).toHaveLength(0); // quiet Add records access but sends no courtesy email.

    const pending = await jsonOf<{ entries: Array<{ kind: string; email: string }> }>(
      await h.GET(OWNER, `/api/canvases/${cv.id}/allowlist`),
    );
    expect(pending.entries).toEqual([
      expect.objectContaining({ kind: "pending", email: GUEST_EMAIL }),
    ]);
    expect(await h.repos.guests.listInvitesByCanvas(cv.id)).toHaveLength(0);

    // Pending grants have no auth power by themselves: before exact-email verified
    // sign-in, another signed-in user still cannot use that pending row.
    expect((await h.GET(OTHER, content)).status).toBe(404);

    // First verified login for that exact email materializes the pending grant into a
    // normal signed-in member allowlist entry. There is no app-issued credential.
    await (await h.GET(GUEST_EMAIL, "/api/me")).text();
    const materialized = await jsonOf<{ entries: Array<{ kind: string; email: string }> }>(
      await h.GET(OWNER, `/api/canvases/${cv.id}/allowlist`),
    );
    expect(materialized.entries).toEqual([
      expect.objectContaining({ kind: "member", email: GUEST_EMAIL }),
    ]);

    // The external person's runtime identity is now a signed-in user. They may use KV
    // under their own user scope; legacy guest-only AI gates are not involved.
    const meExternal = await jsonOf<{ kind: string; email: string }>(
      await h.GET(GUEST_EMAIL, `/v1/c/${cv.slug}/me`),
    );
    expect(meExternal).toMatchObject({ kind: "member", email: GUEST_EMAIL });
    const externalKv = await h.SEND(GUEST_EMAIL, "PUT", `/v1/c/${cv.slug}/kv/user/pref`, "set");
    expect(externalKv.status).toBe(200);

    // Password gate: a member without the cookie is gated (401); the right password admits.
    await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, {
      access: "whole_org",
      password: "hunter2",
    });
    const gated = await h.GET(MEMBER, content);
    expect(gated.status).toBe(401);
    expect((await gated.text()).toLowerCase()).toContain("password");
    const submit = await h.app.request(content, {
      method: "POST",
      headers: h.headers(MEMBER, {
        "Sec-Fetch-Site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: "password=hunter2",
    });
    expect(submit.status).toBe(303);
    const gateCookie = cookiePair(submit, "__canvasdrop_gate");
    expect(gateCookie).toBeTruthy();
    const admitted = await h.GET(MEMBER, content, { cookie: gateCookie as string });
    expect(admitted.status).toBe(200);
    expect(await admitted.text()).toContain("secret");

    // Revoke is instant: lowering whole_org → private 404s the member on the next request.
    await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, {
      access: "private",
      password: null,
    });
    expect((await h.GET(MEMBER, content)).status).toBe(404);

    // Expiry is re-checked per request: a past sharedExpiresAt 404s an otherwise-allowed member.
    await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, { access: "whole_org" });
    expect((await h.GET(MEMBER, content)).status).toBe(200);
    await h.repos.canvases.updateSettings(cv.id, { sharedExpiresAt: Date.now() - 1000 });
    expect((await h.GET(MEMBER, content)).status).toBe(404);

    // public_link is default-on: a fresh owner can set it.
    await h.repos.canvases.updateSettings(cv.id, { sharedExpiresAt: null });
    const pub = await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, {
      access: "public_link",
    });
    expect(pub.status).toBe(200);
  });

  // ── S9 — Admin governance & the hard invariants ──────────────────────────────
  it("S9: admin overview/list + takedown/restore + allowlist/quotas + no cross-owner access + public grant", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client);
    const cv = await jsonOf<{ id: string; slug: string }>(
      await h.SEND(OWNER, "POST", "/api/canvases/paste", { html: "<h1>app</h1>" }),
    );
    await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, { access: "whole_org" });
    await h.GET(MEMBER, `/c/${cv.slug}/`); // records a view for the usage rollups

    // A non-admin cannot see the admin surface (404, no existence leak).
    expect((await h.GET(MEMBER, "/api/admin/overview")).status).toBe(404);

    // Admin overview + all-canvases list show the platform + the seeded canvas.
    const overview = await jsonOf<{
      userCount: number;
      canvasCountByStatus: Record<string, number>;
    }>(await h.GET(ADMIN, "/api/admin/overview"));
    expect(overview.userCount).toBeGreaterThanOrEqual(2);
    expect(overview.canvasCountByStatus.active).toBeGreaterThanOrEqual(1);
    const adminList = await jsonOf<{ canvases: { id: string; owner: { email: string } }[] }>(
      await h.GET(ADMIN, "/api/admin/canvases"),
    );
    expect(adminList.canvases.find((c) => c.id === cv.id)?.owner.email).toBe(OWNER);

    // Disable/takedown: owner sees the reason; a non-owner 404s; owner mutations 409; the URL is gated.
    expect(
      (
        await h.SEND(ADMIN, "POST", `/api/admin/canvases/${cv.id}/disable`, {
          reason: "policy violation",
        })
      ).status,
    ).toBe(200);
    expect(
      (await jsonOf<{ disabledReason: string }>(await h.GET(OWNER, `/api/canvases/${cv.id}`)))
        .disabledReason,
    ).toBe("policy violation");
    expect((await h.GET(MEMBER, `/api/canvases/${cv.id}`)).status).toBe(404);
    const blockedMutation = await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, {
      title: "x",
    });
    expect(blockedMutation.status).toBe(409);
    expect((await jsonOf<{ code: string }>(blockedMutation)).code).toBe("DISABLED");
    // The canvas was shared (whole_org), so its audience sees a 403 takedown page,
    // not the content (a *private* canvas would 404 instead — don't confirm existence).
    const disabledView = await h.GET(MEMBER, `/c/${cv.slug}/`);
    expect(disabledView.status).toBe(403);
    expect(await disabledView.text()).not.toContain("<h1>app</h1>");

    // §12.0 #3: an admin gets NO owner access to a canvas it doesn't own.
    expect((await h.GET(ADMIN, `/api/canvases/${cv.id}`)).status).toBe(404);

    // Enable clears the takedown; the owner can mutate again.
    expect((await h.SEND(ADMIN, "POST", `/api/admin/canvases/${cv.id}/enable`)).status).toBe(200);
    expect(
      (await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, { title: "Renamed" }))
        .status,
    ).toBe(200);

    // Restore reverses a soft-delete.
    await h.SEND(OWNER, "DELETE", `/api/canvases/${cv.id}`);
    expect((await h.GET(OWNER, `/api/canvases/${cv.id}`)).status).toBe(404);
    expect((await h.SEND(ADMIN, "POST", `/api/admin/canvases/${cv.id}/restore`)).status).toBe(200);
    expect((await h.GET(OWNER, `/api/canvases/${cv.id}`)).status).toBe(200);

    // Model allowlist + global quota defaults are admin-managed and read back.
    expect(
      (
        await h.SEND(ADMIN, "PUT", "/api/admin/settings/models", {
          models: [AI_MODEL, "claude-sonnet-4-6"],
        })
      ).status,
    ).toBe(200);
    const models = await jsonOf<{ models: string[] }>(
      await h.GET(ADMIN, "/api/admin/settings/models"),
    );
    expect(models.models).toContain("claude-sonnet-4-6");
    expect(
      (
        await h.SEND(ADMIN, "PUT", "/api/admin/settings/quotas", {
          quotas: { "ai.user.daily.usd": 9 },
        })
      ).status,
    ).toBe(200);
    const quotas = await jsonOf<{ quotas: { key: string; value: number }[] }>(
      await h.GET(ADMIN, "/api/admin/settings/quotas"),
    );
    expect(quotas.quotas.find((q) => q.key === "ai.user.daily.usd")?.value).toBe(9);

    // public_link default-on, with per-user revoke still enforced immediately.
    const ownerUser = await h.repos.users.findByEmail(OWNER);
    expect(
      (await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, { access: "public_link" }))
        .status,
    ).toBe(200);
    expect(
      (await h.SEND(ADMIN, "POST", `/api/admin/users/${ownerUser?.id}/revoke-public`)).status,
    ).toBe(200);
    expect((await h.repos.canvases.findById(cv.id))?.access).toBe("private");
    expect(
      (await h.SEND(OWNER, "PATCH", `/api/canvases/${cv.id}/settings`, { access: "public_link" }))
        .status,
    ).toBe(403);
  });

  // ── S10 — Agent over MCP at dashboard parity + clone/usage/docs/gallery ──────
  it("S10: MCP create→publish→version→rollback→share→clone→usage at owner parity + llms.txt + gallery", async () => {
    client = await makeTestDb(dialect);
    const h = makeHarness(client);
    const ownerUser = await h.repos.users.upsert({
      providerSub: `dev:${OWNER}`,
      email: OWNER,
      name: "owner",
      isAdmin: false,
    });
    const mcp = await connectMcp(h, { userId: ownerUser.id });

    // whoami → the connected account.
    expect(mcpPayload(await mcp.callTool({ name: "whoami", arguments: {} }))).toMatchObject({
      id: ownerUser.id,
      email: OWNER,
    });

    // create → write draft → publish; the live URL (served by the HTTP app) reflects it (parity).
    const created = mcpPayload(
      await mcp.callTool({ name: "create_canvas", arguments: { title: "Agent build" } }),
    );
    expect(created.id).toBeTruthy();
    expect(created.apiKey).toBeTruthy();
    await mcp.callTool({
      name: "write_draft_file",
      arguments: { id: created.id, path: "index.html", content: "<h1>mcp v1</h1>" },
    });
    expect(
      mcpPayload(await mcp.callTool({ name: "publish_draft", arguments: { id: created.id } }))
        .version,
    ).toBe(1);
    expect(
      mcpPayload(await mcp.callTool({ name: "get_canvas", arguments: { id: created.id } }))
        .publicationState,
    ).toBe("published");
    expect(await (await h.GET(OWNER, `/c/${created.slug}/`)).text()).toContain("mcp v1");

    // list_versions, a second publish, and rollback restore an earlier version.
    expect(
      mcpPayload(await mcp.callTool({ name: "list_versions", arguments: { id: created.id } }))
        .versions,
    ).toHaveLength(1);
    await mcp.callTool({
      name: "write_draft_file",
      arguments: { id: created.id, path: "index.html", content: "<h1>mcp v2</h1>" },
    });
    expect(
      mcpPayload(await mcp.callTool({ name: "publish_draft", arguments: { id: created.id } }))
        .version,
    ).toBe(2);
    await mcp.callTool({ name: "rollback_canvas", arguments: { id: created.id, version: 1 } });
    expect(await (await h.GET(OWNER, `/c/${created.slug}/`)).text()).toContain("mcp v1");

    // share via update_canvas; clone yields a fresh unpublished draft owned by the caller; usage reads back.
    await mcp.callTool({
      name: "update_canvas",
      arguments: { id: created.id, access: "whole_org" },
    });
    expect(
      mcpPayload(await mcp.callTool({ name: "get_canvas", arguments: { id: created.id } })).access,
    ).toBe("whole_org");
    const clone = mcpPayload(
      await mcp.callTool({ name: "clone_canvas", arguments: { id: created.id } }),
    );
    expect(clone.id).not.toBe(created.id);
    expect(clone.publicationState).toBe("draft");
    expect(
      typeof mcpPayload(
        await mcp.callTool({ name: "get_canvas_usage", arguments: { id: created.id } }),
      ).totalViews,
    ).toBe("number");

    // Parity owner check: an MCP tool on a canvas owned by someone else → not found.
    const stranger = await h.repos.users.upsert({
      providerSub: `dev:${OTHER}`,
      email: OTHER,
      name: "other",
      isAdmin: false,
    });
    const foreign = await h.repos.canvases.create({
      ownerId: stranger.id,
      slug: "foreign",
      apiKeyHash: "hf",
    });
    expect(
      mcpIsError(await mcp.callTool({ name: "get_canvas", arguments: { id: foreign.id } })),
    ).toBe(true);

    // The public agent docs are served (no login) and document the primitives.
    const llms = await h.app.request("/llms.txt", { headers: { host: h.baseHost } });
    expect(llms.status).toBe(200);
    expect(llms.headers.get("content-type")).toContain("text/plain");
    const llmsBody = await llms.text();
    expect(llmsBody).toContain("Agent-readable reference");
    expect(llmsBody.toLowerCase()).toMatch(/\bkv\b/);

    // Gallery: a shared + listed canvas appears in the org gallery.
    await h.SEND(OWNER, "PATCH", `/api/canvases/${created.id}/settings`, { galleryListed: true });
    const gallery = await jsonOf<{ items: { id: string }[] }>(await h.GET(OWNER, "/api/gallery"));
    expect(gallery.items.map((i) => i.id)).toContain(created.id);
  });
});

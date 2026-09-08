import { loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProvider } from "../ai/testing.js";
import { filesService } from "../canvas/files-service.js";
import type { DbClient } from "../db/factory.js";
import { aiUsageRepository } from "../db/repositories/ai-usage.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { filesRepository } from "../db/repositories/files.js";
import { kvRepository } from "../db/repositories/kv.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usageEventsRepository } from "../db/repositories/usage-events.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { memStorage } from "../storage/mem.js";
import { canvasApiRoutes } from "./canvas-api.js";

const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_AI_API_KEY: "test",
  CANVAS_DROP_AI_MODELS: "claude-haiku-4-5",
});
const put = (body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe.each(DIALECTS)("runtime participant permissions [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => client?.close());

  async function setup(keyLimit?: number) {
    client = await makeTestDb(dialect);
    const users = usersRepository(client);
    const identities = await Promise.all(
      (["owner", "editor", "viewer", "other"] as const).map((name) =>
        users.upsert({
          providerSub: name,
          name,
          email: `${name}@example.com`,
          isAdmin: name === "viewer",
        }),
      ),
    );
    const [owner, editor, viewer, other] = identities;
    if (!owner || !editor || !viewer || !other) throw new Error("missing test identity");
    const canvases = canvasesRepository(client);
    const canvas = await canvases.create({
      ownerId: owner.id,
      slug: "app",
      apiKeyHash: "key",
      backendEnabled: true,
    });
    await canvases.updateSettings(canvas.id, { access: "whole_org" });
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: editor.id,
      role: "editor",
    });
    const teams = teamsRepository(client);
    const storage = memStorage();
    const files = filesService({ files: filesRepository(client), storage });
    function as(user: NonNullable<typeof owner>) {
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("user", user);
        await next();
      });
      app.route(
        "/v1/c/:slug",
        canvasApiRoutes({
          config,
          quota: keyLimit === undefined ? undefined : async () => keyLimit,
          canvases,
          teams,
          files,
          kv: kvRepository(client),
          usage: usageEventsRepository(client),
          aiUsage: aiUsageRepository(client),
          aiProvider: fakeProvider({ deltas: ["ok"] }),
        }),
      );
      return app;
    }
    return { owner, editor, viewer, other, canvases, canvas, teams, as };
  }

  it("reports effective roles and forbids a viewer, including an admin, from changing shared KV", async () => {
    const { owner, editor, viewer, canvases, canvas, as } = await setup();
    for (const [user, role] of [
      [owner, "owner"],
      [editor, "editor"],
      [viewer, "viewer"],
    ] as const) {
      const me = (await (await as(user).request("/v1/c/app/me")).json()) as {
        canvasRole: string;
        permissions: Record<string, boolean>;
      };
      expect(me.canvasRole).toBe(role);
      expect(me.permissions.canWriteSharedData).toBe(role !== "viewer");
      expect(me.permissions.canSubmit).toBe(true);
    }
    const reader = as(viewer);
    for (const request of [put("forged"), { method: "DELETE" }, { method: "POST", body: "{}" }]) {
      const path =
        request.method === "POST" ? "/v1/c/app/kv/question/increment" : "/v1/c/app/kv/question";
      const response = await reader.request(path, request);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "PERMISSION_DENIED" });
    }
    expect((await as(editor).request("/v1/c/app/kv/question", put("Choose a colour"))).status).toBe(
      200,
    );
    expect(await (await reader.request("/v1/c/app/kv/question")).json()).toEqual({
      value: "Choose a colour",
    });
    expect((await reader.request("/v1/c/app/kv/user/theme", put("dark"))).status).toBe(200);
    expect((await as(owner).request("/v1/c/app/kv/user/theme")).status).toBe(404);
    const entry = await canvases.findMemberEntry(canvas.id, editor.id);
    if (!entry) throw new Error("missing editor grant");
    await canvases.setAllowlistRole(canvas.id, entry.id, "viewer");
    expect((await as(editor).request("/v1/c/app/kv/question", put("Changed"))).status).toBe(403);
  });

  it("separates private participant uploads from shared files on list, read and delete", async () => {
    const { owner, editor, viewer, other, as } = await setup();
    async function upload(user: NonNullable<typeof owner>, scope: string) {
      const body = new FormData();
      body.set("file", new File(["response"], "response.txt"));
      body.set("scope", scope);
      return as(user).request("/v1/c/app/files", { method: "POST", body });
    }
    expect((await upload(viewer, "shared")).status).toBe(403);
    const shared = (await (await upload(editor, "shared")).json()) as { id: string };
    const response = (await (await upload(viewer, "submission")).json()) as { id: string };
    expect(response.id).toBeTypeOf("string");
    const listed = await as(other).request("/v1/c/app/files");
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    const list = (await listed.json()) as {
      files: Array<{ id: string }>;
    };
    expect(list.files.map((f: { id: string }) => f.id)).toEqual([shared.id]);
    expect((await as(other).request(`/v1/c/app/files/${response.id}/content`)).status).toBe(404);
    expect(
      (await as(other).request(`/v1/c/app/files/${response.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (await as(viewer).request(`/v1/c/app/files/${shared.id}`, { method: "DELETE" })).status,
    ).toBe(403);
    expect((await as(editor).request(`/v1/c/app/files/${response.id}/content`)).status).toBe(200);
    expect(
      (await as(viewer).request(`/v1/c/app/files/${response.id}`, { method: "DELETE" })).status,
    ).toBe(200);
  });

  it("requires an explicit AI audience and keeps feature gates authoritative", async () => {
    const { viewer, canvases, canvas, as } = await setup();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "hello" }],
      }),
    };
    expect((await as(viewer).request("/v1/c/app/ai/chat", request)).status).toBe(403);
    await canvases.updateCapabilities(canvas.id, { aiAudience: "viewers" });
    const allowed = await as(viewer).request("/v1/c/app/ai/chat", request);
    expect(allowed.status).toBe(200);
    await allowed.text();
    await canvases.updateCapabilities(canvas.id, { ai: false });
    const denied = await as(viewer).request("/v1/c/app/ai/chat", request);
    expect(await denied.json()).toMatchObject({ code: "CAPABILITY_DISABLED" });
  });
  it("isolates submissions by authenticated author and canvas, with editor review and withdrawal", async () => {
    const { owner, editor, viewer, other, canvas, canvases, as } = await setup();
    const path = "/v1/c/app/submissions/vote";
    const forged = { userId: other.id, updatedAt: 1, choice: "blue" };
    const saved = await as(viewer).request(`${path}/mine`, put(forged));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      userId: viewer.id,
      value: forged,
      updatedAt: expect.any(Number),
    });
    expect((await as(other).request(`${path}/mine`)).status).toBe(404);
    expect((await as(other).request(path)).status).toBe(403);
    expect((await as(other).request(`${path}/${viewer.id}`, { method: "DELETE" })).status).toBe(
      403,
    );
    expect((await as(other).request(path, { method: "DELETE" })).status).toBe(403);
    expect((await as(viewer).request(`/v1/c/app/kv/user/vote`)).status).toBe(404);
    await as(viewer).request(`${path}/mine`, put(null));
    expect(await (await as(viewer).request(`${path}/mine`)).json()).toMatchObject({ value: null });
    await as(other).request(`${path}/mine`, put("red"));
    const page = (await (await as(editor).request(`${path}?limit=1`)).json()) as {
      entries: Array<{ userId: string }>;
      nextCursor: string;
    };
    expect(page.entries).toHaveLength(1);
    const next = (await (
      await as(owner).request(`${path}?limit=1&cursor=${page.nextCursor}`)
    ).json()) as { entries: Array<{ userId: string }>; nextCursor: null };
    expect(next.entries).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...page.entries, ...next.entries].map((row) => row.userId))).toEqual(
      new Set([viewer.id, other.id]),
    );
    const second = await canvases.create({
      ownerId: owner.id,
      slug: "second",
      apiKeyHash: "key2",
      backendEnabled: true,
    });
    await canvases.updateSettings(second.id, { access: "whole_org" });
    expect(await (await as(owner).request("/v1/c/second/submissions/vote")).json()).toEqual({
      entries: [],
      nextCursor: null,
    });
    await as(editor).request(`${path}/${other.id}`, { method: "DELETE" });
    expect((await as(other).request(`${path}/mine`)).status).toBe(404);
    await as(viewer).request(`${path}/mine`, { method: "DELETE" });
    expect((await as(viewer).request(`${path}/mine`)).status).toBe(404);
    await as(viewer).request(`${path}/mine`, put("green"));
    const grant = await canvases.findMemberEntry(canvas.id, editor.id);
    if (!grant) throw new Error("missing grant");
    await canvases.setAllowlistRole(canvas.id, grant.id, "viewer");
    expect((await as(editor).request(path)).status).toBe(403);
    await as(owner).request(path, { method: "DELETE" });
    expect(await (await as(owner).request(path)).json()).toEqual({ entries: [], nextCursor: null });
    await canvases.updateCapabilities(canvas.id, { kv: false });
    expect(await (await as(viewer).request(`${path}/mine`, put("denied"))).json()).toMatchObject({
      code: "CAPABILITY_DISABLED",
    });
  });

  it("bounds submissions across collections and rejects malformed input while allowing updates at quota", async () => {
    const { owner, viewer, as } = await setup(1);
    const app = as(viewer);
    expect((await app.request("/v1/c/app/submissions/first/mine", put("one"))).status).toBe(200);
    expect((await app.request("/v1/c/app/submissions/first/mine", put("updated"))).status).toBe(
      200,
    );
    expect((await app.request("/v1/c/app/submissions/second/mine", put("two"))).status).toBe(409);
    expect(
      (await as(owner).request("/v1/c/app/submissions/first/mine", put("too many"))).status,
    ).toBe(409);
    for (const collection of ["bad%3Aname", "a".repeat(81)]) {
      expect((await app.request(`/v1/c/app/submissions/${collection}/mine`, put("x"))).status).toBe(
        400,
      );
    }
    expect(
      (await app.request("/v1/c/app/submissions/first/mine", { method: "PUT", body: "{" })).status,
    ).toBe(400);
    expect(
      (await app.request("/v1/c/app/submissions/first/mine", put("x".repeat(65536)))).status,
    ).toBe(413);
    for (const query of ["limit=NaN", "limit=1.5", "limit=1001", "cursor=%25", "cursor="]) {
      expect((await as(owner).request(`/v1/c/app/submissions/first?${query}`)).status).toBe(400);
    }
  });
  it("derives team roles live on a restricted canvas and refuses unrelated users", async () => {
    const { owner, viewer, other, canvases, canvas, teams, as } = await setup();
    await canvases.updateSettings(canvas.id, { access: "private" });
    const team = await teams.create({ orgId: null, name: "Reviewers", createdBy: owner.id });
    await teams.addMember(team.id, viewer.id);
    await teams.setCanvasTeamRole(canvas.id, team.id, "viewer");
    expect(await (await as(viewer).request("/v1/c/app/me")).json()).toMatchObject({
      canvasRole: "viewer",
    });
    expect((await as(other).request("/v1/c/app/me")).status).toBe(404);
    await teams.setCanvasTeamRole(canvas.id, team.id, "editor");
    expect(await (await as(viewer).request("/v1/c/app/me")).json()).toMatchObject({
      canvasRole: "editor",
      permissions: { canManageSubmissions: true },
    });
    expect((await as(viewer).request("/v1/c/app/kv/config", put("allowed"))).status).toBe(200);
    await teams.setCanvasTeamRole(canvas.id, team.id, "viewer");
    expect((await as(viewer).request("/v1/c/app/kv/config", put("denied"))).status).toBe(403);
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: other.id,
      role: "viewer",
    });
    expect(await (await as(other).request("/v1/c/app/me")).json()).toMatchObject({
      canvasRole: "viewer",
    });
  });
});

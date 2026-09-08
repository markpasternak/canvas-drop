import {
  type DataPolicy,
  emptyRuntimePolicy,
  loadConfig,
  PolicyConflictError,
  type RuntimePolicy,
} from "@canvas-drop/shared";
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

  it("supports multiple shared contributions with immutable authorship and own-item mutation", async () => {
    const { owner, viewer, other, canvases, canvas, as } = await setup();
    await canvases.updateCapabilities(canvas.id, {
      runtimePolicy: {
        defaultMode: "participation",
        collections: { comments: { preset: "contributions" } },
        fileGroups: {},
        channels: {},
        connections: {},
      },
      expectedRuntimePolicy: null,
    });
    const path = "/v1/c/app/collections/comments";
    const first = await as(viewer).request(path, {
      ...put({ text: "one", authorId: owner.id }),
      method: "POST",
    });
    expect(first.status).toBe(201);
    const record = (await first.json()) as { id: string; authorId: string };
    expect(record.authorId).toBe(viewer.id);
    expect(
      (await as(viewer).request(path, { ...put({ text: "two" }), method: "POST" })).status,
    ).toBe(201);
    expect(await (await as(other).request(path)).json()).toMatchObject({
      entries: expect.any(Array),
    });
    expect(
      ((await (await as(other).request(path)).json()) as { entries: unknown[] }).entries,
    ).toHaveLength(2);
    expect((await as(other).request(`${path}/${record.id}`, put({ text: "forged" }))).status).toBe(
      403,
    );
    expect((await as(other).request(`${path}/${record.id}`, { method: "DELETE" })).status).toBe(
      403,
    );
    expect((await as(viewer).request(`${path}/${record.id}`, put({ text: "own" }))).status).toBe(
      200,
    );
    expect(
      (await as(owner).request(`${path}/${record.id}`, put({ text: "moderated" }))).status,
    ).toBe(200);
    expect(await (await as(viewer).request(`${path}/${record.id}`)).json()).toMatchObject({
      authorId: viewer.id,
    });
    expect((await as(viewer).request(`${path}/${record.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
  });

  it("enforces all five presets for reads, updates, bulk deletion and private aggregates", async () => {
    const { owner, viewer, other, canvases, canvas, as } = await setup();
    const policy = emptyRuntimePolicy();
    for (const preset of [
      "personal",
      "submissions",
      "contributions",
      "managed",
      "collaborative",
    ] as const)
      policy.collections[preset] = { preset };
    await canvases.updateCapabilities(canvas.id, {
      runtimePolicy: policy,
      expectedRuntimePolicy: null,
    });
    for (const preset of Object.keys(policy.collections)) {
      const path = `/v1/c/app/collections/${preset}`;
      const response = await as(viewer).request(path, { ...put(1), method: "POST" });
      if (preset === "managed") {
        expect(response.status).toBe(403);
        continue;
      }
      const record = (await response.json()) as { id: string };
      expect((await as(other).request(`${path}/${record.id}`)).status).toBe(
        ["personal", "submissions"].includes(preset) ? 404 : 200,
      );
      expect((await as(owner).request(`${path}/${record.id}`)).status).toBe(
        preset === "personal" ? 404 : 200,
      );
      expect((await as(other).request(`${path}/${record.id}`, put(2))).status).toBe(
        preset === "collaborative" ? 200 : ["personal", "submissions"].includes(preset) ? 404 : 403,
      );
      const page = (await (await as(other).request(path)).json()) as { entries: unknown[] };
      expect(page.entries.length).toBe(["personal", "submissions"].includes(preset) ? 0 : 1);
      const clear = (await (await as(other).request(path, { method: "DELETE" })).json()) as {
        deleted: number;
      };
      expect(clear.deleted).toBe(preset === "collaborative" ? 1 : 0);
      expect((await as(viewer).request(`${path}/count`)).status).toBe(403);
    }
    const stored = await canvases.findById(canvas.id);
    policy.collections.submissions = { preset: "submissions", aggregateCount: "viewers" };
    await canvases.updateCapabilities(canvas.id, {
      runtimePolicy: policy,
      expectedRuntimePolicy: stored?.runtimePolicy,
    });
    expect(
      await (await as(other).request("/v1/c/app/collections/submissions/count")).json(),
    ).toEqual({ count: 1 });
    expect((await as(other).request("/v1/c/app/collections/toString")).status).toBe(400);
  });

  it("filters before pagination and atomically increments without changing authorship", async () => {
    const { owner, viewer, other, canvases, canvas, as } = await setup();
    const policy = emptyRuntimePolicy();
    policy.collections.items = { preset: "personal" };
    await canvases.updateCapabilities(canvas.id, {
      runtimePolicy: policy,
      expectedRuntimePolicy: null,
    });
    const path = "/v1/c/app/collections/items";
    await as(other).request(path, { ...put(99), method: "POST" });
    const first = (await (
      await as(viewer).request(path, { ...put(0), method: "POST" })
    ).json()) as { id: string };
    await as(viewer).request(path, { ...put(5), method: "POST" });
    const page = (await (await as(viewer).request(`${path}?limit=1`)).json()) as {
      entries: { id: string }[];
      nextCursor: string;
    };
    expect(page.entries[0]?.id).toBe(first.id);
    expect(page.nextCursor).toBe(first.id);
    const next = (await (
      await as(viewer).request(`${path}?limit=1&cursor=${page.nextCursor}`)
    ).json()) as { entries: unknown[]; nextCursor: string | null };
    expect(next.entries).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        as(viewer).request(`${path}/${first.id}/increment`, { ...put({ by: 1 }), method: "POST" }),
      ),
    );
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(await (await as(viewer).request(`${path}/${first.id}`)).json()).toMatchObject({
      value: 8,
      authorId: viewer.id,
    });
    expect(
      (
        await as(owner).request(`${path}/${first.id}/increment`, {
          ...put({ by: 1 }),
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect((await as(viewer).request(`${path}?limit=1001`)).status).toBe(400);
    await as(viewer).request(`${path}/${first.id}`, put(Number.MAX_VALUE));
    expect(
      (
        await as(viewer).request(`${path}/${first.id}/increment`, {
          ...put({ by: Number.MAX_VALUE }),
          method: "POST",
        })
      ).status,
    ).toBe(409);
    expect(await (await as(viewer).request(`${path}/${first.id}`)).json()).toMatchObject({
      value: Number.MAX_VALUE,
    });
    await as(viewer).request(`${path}/${first.id}`, put({ text: "not a number" }));
    expect(
      (
        await as(viewer).request(`${path}/${first.id}/increment`, {
          ...put({ by: 1 }),
          method: "POST",
        })
      ).status,
    ).toBe(409);
  });

  it("protects attached files and standalone personal files, including content URLs and parent deletion", async () => {
    const { owner, viewer, other, canvases, canvas, as } = await setup();
    const policy = emptyRuntimePolicy();
    policy.collections.comments = { preset: "contributions" };
    policy.fileGroups.private = { preset: "personal" };
    const saved = await canvases.updateCapabilities(canvas.id, {
      runtimePolicy: policy,
      expectedRuntimePolicy: null,
    });
    const path = "/v1/c/app/collections/comments";
    const record = (await (
      await as(viewer).request(path, { ...put("comment"), method: "POST" })
    ).json()) as { id: string };
    const upload = (user: typeof viewer, fields: Record<string, string>) => {
      const form = new FormData();
      form.set("file", new File(["image"], "image.txt"));
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      return as(user).request("/v1/c/app/files", { method: "POST", body: form });
    };
    expect((await upload(other, { collection: "comments", recordId: record.id })).status).toBe(403);
    const attached = (await (
      await upload(viewer, { collection: "comments", recordId: record.id })
    ).json()) as { id: string };
    const filePath = `/v1/c/app/files/${attached.id}`;
    expect((await as(other).request(`${filePath}/content`)).status).toBe(200);
    expect((await as(other).request(filePath, { method: "DELETE" })).status).toBe(403);
    expect(
      (await as(viewer).request(filePath, { ...put({ name: "renamed.txt" }), method: "PATCH" }))
        .status,
    ).toBe(200);
    policy.collections.comments = { preset: "submissions" };
    await canvases.updateCapabilities(canvas.id, {
      runtimePolicy: policy,
      expectedRuntimePolicy: saved.runtimePolicy,
    });
    expect((await as(other).request(`${filePath}/content`)).status).toBe(404);
    expect((await as(owner).request(`${filePath}/content`)).status).toBe(200);
    const personal = (await (await upload(viewer, { group: "private" })).json()) as { id: string };
    expect((await as(owner).request(`/v1/c/app/files/${personal.id}/content`)).status).toBe(404);
    const ownerList = (await (await as(owner).request("/v1/c/app/files")).json()) as {
      files: { id: string }[];
    };
    expect(ownerList.files.map((file) => file.id)).not.toContain(personal.id);
    await as(viewer).request(`${path}/${record.id}`, { method: "DELETE" });
    expect((await as(owner).request(`${filePath}/content`)).status).toBe(404);
    expect(
      (await as(viewer).request(`/v1/c/app/files/${personal.id}`, { method: "DELETE" })).status,
    ).toBe(200);
  });

  it("rejects stale or missing policy revisions and preserves existing resources when defaults change", async () => {
    const { canvases, canvas } = await setup();
    const policy = emptyRuntimePolicy();
    policy.collections.comments = { preset: "contributions" };
    const saved = await canvases.updateCapabilities(canvas.id, {
      runtimePolicy: policy,
      expectedRuntimePolicy: null,
    });
    const next: RuntimePolicy = { ...policy, defaultMode: "read_only" };
    await expect(
      canvases.updateCapabilities(canvas.id, { runtimePolicy: next, expectedRuntimePolicy: null }),
    ).rejects.toBeInstanceOf(PolicyConflictError);
    await expect(
      canvases.updateCapabilities(canvas.id, { runtimePolicy: next }),
    ).rejects.toBeInstanceOf(PolicyConflictError);
    const updated = await canvases.updateCapabilities(canvas.id, {
      runtimePolicy: next,
      expectedRuntimePolicy: saved.runtimePolicy,
    });
    expect(JSON.parse(updated.runtimePolicy ?? "{}").collections.comments).toEqual({
      preset: "contributions",
    });
  });

  it("bounds collections across names and applies granular create/delete overrides", async () => {
    const { viewer, owner, canvases, canvas, as } = await setup(1);
    const policy = emptyRuntimePolicy();
    const entry: DataPolicy = {
      preset: "contributions",
      overrides: { delete: "editors", increment: "none" },
    };
    policy.collections.first = entry;
    policy.collections.second = entry;
    await canvases.updateCapabilities(canvas.id, {
      runtimePolicy: policy,
      expectedRuntimePolicy: null,
    });
    const path = "/v1/c/app/collections/first";
    const row = (await (await as(viewer).request(path, { ...put(0), method: "POST" })).json()) as {
      id: string;
    };
    expect(
      (await as(viewer).request("/v1/c/app/collections/second", { ...put(0), method: "POST" }))
        .status,
    ).toBe(409);
    expect((await as(viewer).request(`${path}/${row.id}`, put(2))).status).toBe(200);
    expect((await as(viewer).request(`${path}/${row.id}`, { method: "DELETE" })).status).toBe(403);
    expect(
      (
        await as(owner).request(`${path}/${row.id}/increment`, {
          ...put({ by: 1 }),
          method: "POST",
        })
      ).status,
    ).toBe(403);
    const identity = (await (await as(viewer).request("/v1/c/app/me")).json()) as {
      resources: {
        collections: {
          first: { delete: { own: boolean }; update: { own: boolean; any: boolean } };
        };
      };
    };
    expect(identity.resources.collections.first.delete.own).toBe(false);
    expect(identity.resources.collections.first.update).toEqual({ own: true, any: false });
  });

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

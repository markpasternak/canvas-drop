import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { orgMembersRepository } from "../db/repositories/org-members.js";
import { orgsRepository } from "../db/repositories/orgs.js";
import { teamsRepository } from "../db/repositories/teams.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { peopleRoutes } from "./people.js";

const config: Config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_ORG_NAME: "Acme",
});

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function appFor(
  client: DbClient,
  actor: { id: string; email: string; name: string; isAdmin: boolean },
  orgIds: Set<string>,
  cfg = config,
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { ...actor, canPublishPublic: true } as never);
    c.set("orgIds", orgIds);
    await next();
  });
  app.route(
    "/api/people",
    peopleRoutes({
      config: cfg,
      canvases: canvasesRepository(client),
      teams: teamsRepository(client),
      users: usersRepository(client),
      orgMembers: orgMembersRepository(client),
    }),
  );
  return app;
}

async function user(client: DbClient, email: string, name = email) {
  return usersRepository(client).upsert({ providerSub: email, email, name, isAdmin: false });
}

describe("peopleRoutes", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("searches eligible org members for an owned canvas and hides existing grants", async () => {
    client = await makeTestDb("sqlite");
    const org = await orgsRepository(client).ensureOrg({
      name: "Acme",
      slug: "acme",
      domains: ["example.com"],
    });
    const orgMembers = orgMembersRepository(client);
    const owner = await user(client, "owner@example.com", "Owner");
    const colleague = await user(client, "colleague@example.com", "Colleague");
    const alreadyAdded = await user(client, "added@example.com", "Already Added");
    await user(client, "outsider@example.com", "Outsider");
    for (const u of [owner, colleague, alreadyAdded]) {
      await orgMembers.upsertDomainMember(org.id, u.id);
    }
    const canvases = canvasesRepository(client);
    const canvas = await canvases.create({
      ownerId: owner.id,
      slug: "team-canvas",
      apiKeyHash: "hash",
      orgId: org.id,
    });
    await canvases.addAllowlistEntry({
      canvasId: canvas.id,
      principalKind: "member",
      userId: alreadyAdded.id,
    });

    const res = await appFor(client, owner, new Set([org.id])).request(
      `/api/people/search?context=canvas&canvasId=${canvas.id}&q=example`,
    );
    expect(res.status).toBe(200);
    const body = await jsonOf<{ people: Array<{ email: string }> }>(res);
    expect(body.people.map((p) => p.email)).toEqual(["colleague@example.com"]);

    const other = await user(client, "other@example.com", "Other");
    await orgMembers.upsertDomainMember(org.id, other.id);
    const denied = await appFor(client, other, new Set([org.id])).request(
      `/api/people/search?context=canvas&canvasId=${canvas.id}&q=colleague`,
    );
    expect(denied.status).toBe(404);
  });

  it("searches org team members and returns no autocomplete for personal teams", async () => {
    client = await makeTestDb("sqlite");
    const org = await orgsRepository(client).ensureOrg({
      name: "Acme",
      slug: "acme",
      domains: ["example.com"],
    });
    const orgMembers = orgMembersRepository(client);
    const teams = teamsRepository(client);
    const owner = await user(client, "owner@example.com", "Owner");
    const colleague = await user(client, "colleague@example.com", "Colleague");
    const alreadyAdded = await user(client, "added@example.com", "Already Added");
    await user(client, "outsider@example.com", "Outsider");
    for (const u of [owner, colleague, alreadyAdded]) {
      await orgMembers.upsertDomainMember(org.id, u.id);
    }
    const team = await teams.create({ orgId: org.id, name: "Design", createdBy: owner.id });
    await teams.addMember(team.id, alreadyAdded.id);

    const res = await appFor(client, owner, new Set([org.id])).request(
      `/api/people/search?context=team&teamId=${team.id}&q=example`,
    );
    expect(res.status).toBe(200);
    expect(
      (await jsonOf<{ people: Array<{ email: string }> }>(res)).people.map((p) => p.email),
    ).toEqual(["colleague@example.com"]);

    const personal = await teams.create({ orgId: null, name: "Friends", createdBy: owner.id });
    const personalRes = await appFor(client, owner, new Set([org.id])).request(
      `/api/people/search?context=team&teamId=${personal.id}&q=example`,
    );
    expect(personalRes.status).toBe(200);
    expect((await jsonOf<{ people: unknown[] }>(personalRes)).people).toHaveLength(0);
  });
});

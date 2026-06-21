import type { Org } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../http/types.js";
import { meRoutes } from "./me.js";

interface MeBody {
  id: string;
  orgs: Array<{ id: string; name: string }>;
  isGuest: boolean;
}

function appWith(orgIds: Set<string>, tenancyActive: boolean) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "u1",
      email: "u@acme.com",
      name: "U",
      avatarUrl: null,
      isAdmin: false,
      canPublishPublic: false,
    } as never);
    c.set("orgIds", orgIds);
    await next();
  });
  app.route(
    "/",
    meRoutes({
      authMode: "dev",
      urlMode: "path",
      baseUrl: "http://localhost",
      designSkin: async () => "editorial",
      orgs: {
        async findById(id: string): Promise<Org | null> {
          return { id, name: `Org ${id}`, slug: id, createdAt: 0 };
        },
      },
      tenancyActive,
    }),
  );
  return app;
}

describe("meRoutes — tenancy (plan 002 U6)", () => {
  it("a member exposes their orgs and is not a guest", async () => {
    const res = await appWith(new Set(["org-1"]), true).request("/");
    const body = (await res.json()) as MeBody;
    expect(body.orgs).toEqual([{ id: "org-1", name: "Org org-1" }]);
    expect(body.isGuest).toBe(false);
  });

  it("a signed-in user in no org is a guest (active tenancy)", async () => {
    const res = await appWith(new Set(), true).request("/");
    const body = (await res.json()) as MeBody;
    expect(body.orgs).toEqual([]);
    expect(body.isGuest).toBe(true);
  });

  it("inert tenancy: no org boundary — isGuest is false even with no orgs", async () => {
    const res = await appWith(new Set(), false).request("/");
    const body = (await res.json()) as MeBody;
    expect(body.orgs).toEqual([]);
    expect(body.isGuest).toBe(false);
  });
});

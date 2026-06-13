import type { User } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../http/types.js";
import { requireAdmin } from "./authz.js";

function appWith(isAdmin: boolean) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "u1", isAdmin } as User);
    await next();
  });
  app.use("*", requireAdmin());
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}

describe("requireAdmin", () => {
  it("lets an admin through to the handler", async () => {
    const res = await appWith(true).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s a non-admin (no existence leak), handler never runs", async () => {
    const res = await appWith(false).request("/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

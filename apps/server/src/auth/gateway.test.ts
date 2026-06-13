import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { devStrategy } from "./dev.js";
import { type AuthEvent, type AuthEventSink, authGateway } from "./gateway.js";
import type { AuthStrategy } from "./strategy.js";

const adminConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_DEV_USER_EMAIL: "mark@example.com",
  CANVAS_DROP_DEV_USER_NAME: "Mark",
  CANVAS_DROP_ADMIN_EMAILS: "mark@example.com",
});

const nonAdminConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_DEV_USER_EMAIL: "user@example.com",
  CANVAS_DROP_ADMIN_EMAILS: "someone-else@example.com",
});

function buildApp(
  client: DbClient,
  opts: { strategy?: AuthStrategy; config?: Config; events?: AuthEvent[] } = {},
) {
  const config = opts.config ?? adminConfig;
  const audit: AuthEventSink | undefined = opts.events
    ? { record: (e) => opts.events?.push(e) }
    : undefined;

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("clientIp", "127.0.0.1");
    await next();
  });
  app.use(
    "*",
    authGateway({
      strategy: opts.strategy ?? devStrategy(config),
      config,
      users: usersRepository(client),
      audit,
    }),
  );
  app.get("/me", (c) => {
    const u = c.get("user");
    return c.json({ id: u.id, email: u.email, isAdmin: u.isAdmin });
  });
  return app;
}

describe("authGateway", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("dev mode: authenticates the request and exposes the user downstream", async () => {
    client = await makeTestDb("sqlite");
    const events: AuthEvent[] = [];
    const res = await buildApp(client, { events }).request("/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; isAdmin: boolean };
    expect(body.email).toBe("mark@example.com");
    expect(body.isAdmin).toBe(true);
    expect(events.some((e) => e.action === "auth_ok")).toBe(true);
  });

  it("rejects an identity whose email domain is not allowed", async () => {
    client = await makeTestDb("sqlite");
    const events: AuthEvent[] = [];
    const evilStrategy: AuthStrategy = {
      async resolveIdentity() {
        return { sub: "evil", email: "attacker@evil.org" };
      },
    };
    const res = await buildApp(client, { strategy: evilStrategy, events }).request("/me");
    expect(res.status).toBe(401);
    expect(
      events.some((e) => e.action === "auth_denied" && e.reason === "domain_not_allowed"),
    ).toBe(true);
  });

  it("creates exactly one user across repeat requests (upsert, no duplicate)", async () => {
    client = await makeTestDb("sqlite");
    const app = buildApp(client);
    const b1 = (await (await app.request("/me")).json()) as { id: string };
    const b2 = (await (await app.request("/me")).json()) as { id: string };
    expect(b2.id).toBe(b1.id);
  });

  it("does not grant admin to a non-admin email", async () => {
    client = await makeTestDb("sqlite");
    const res = await buildApp(client, { config: nonAdminConfig }).request("/me");
    const body = (await res.json()) as { isAdmin: boolean };
    expect(body.isAdmin).toBe(false);
  });

  it("rejects a blocked user with 403", async () => {
    client = await makeTestDb("sqlite");
    const app = buildApp(client);
    await app.request("/me"); // first sight creates the user
    const repo = usersRepository(client);
    const user = await repo.findByProviderSub("dev:mark@example.com");
    await repo.setBlocked(user?.id ?? "", true);
    const res = await app.request("/me");
    expect(res.status).toBe(403);
  });
});

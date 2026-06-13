import { type Config, loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { hashToken, sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { SESSION_COOKIE, sessionBackedStrategy, sessionService } from "./session.js";

const pathConfig = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const subConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvases.example.com",
});

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}
function cookieToken(res: Response): string | undefined {
  for (const sc of setCookies(res)) {
    const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(sc);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return undefined;
}

async function seedUser(client: DbClient): Promise<string> {
  const u = await usersRepository(client).upsert({
    providerSub: "oidc:s1",
    email: "user@example.com",
    name: "User",
    isAdmin: false,
  });
  return u.id;
}

function buildApp(config: Config, client: DbClient) {
  const svc = sessionService(config, sessionsRepository(client));
  const strat = sessionBackedStrategy(svc, usersRepository(client));
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("clientIp", "127.0.0.1");
    await next();
  });
  app.get("/issue/:uid", async (c) => {
    await svc.issue(c, c.req.param("uid"));
    return c.text("ok");
  });
  app.get("/whoami", async (c) => c.json({ uid: await svc.resolveUserId(c) }));
  app.get("/logout", async (c) => {
    await svc.revoke(c);
    return c.text("bye");
  });
  app.get("/identity", async (c) => c.json({ id: await strat.resolveIdentity(c) }));
  return app;
}

describe("sessionService", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("issues an HttpOnly SameSite=Lax cookie holding a token whose hash is stored", async () => {
    client = await makeTestDb("sqlite");
    const uid = await seedUser(client);
    const app = buildApp(pathConfig, client);
    const res = await app.request(`/issue/${uid}`);
    const raw = setCookies(res).find((c) => c.startsWith(SESSION_COOKIE));
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);

    const token = cookieToken(res) as string;
    const session = await sessionsRepository(client).findLiveByToken(token);
    expect(session?.tokenHash).toBe(hashToken(token));
    expect(session?.tokenHash).not.toBe(token);
  });

  it("resolves a valid cookie to the user id and rejects garbage / missing cookies", async () => {
    client = await makeTestDb("sqlite");
    const uid = await seedUser(client);
    const app = buildApp(pathConfig, client);
    const token = cookieToken(await app.request(`/issue/${uid}`)) as string;

    const ok = await app.request("/whoami", { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
    expect((await jsonOf<{ uid: string | null }>(ok)).uid).toBe(uid);

    const none = await app.request("/whoami");
    expect((await jsonOf<{ uid: string | null }>(none)).uid).toBeNull();

    const bad = await app.request("/whoami", {
      headers: { Cookie: `${SESSION_COOKIE}=not-a-real-token` },
    });
    expect((await jsonOf<{ uid: string | null }>(bad)).uid).toBeNull();
  });

  it("revokes the session on logout", async () => {
    client = await makeTestDb("sqlite");
    const uid = await seedUser(client);
    const app = buildApp(pathConfig, client);
    const token = cookieToken(await app.request(`/issue/${uid}`)) as string;
    const cookie = `${SESSION_COOKIE}=${token}`;

    await app.request("/logout", { headers: { Cookie: cookie } });
    const after = await app.request("/whoami", { headers: { Cookie: cookie } });
    expect((await jsonOf<{ uid: string | null }>(after)).uid).toBeNull();
  });

  it("records session_create and session_revoke audit events when a sink is provided", async () => {
    client = await makeTestDb("sqlite");
    const uid = await seedUser(client);
    const events: Array<{ action: string; actorId?: string | null }> = [];
    const svc = sessionService(pathConfig, sessionsRepository(client), {
      recordAudit: (e) => events.push(e),
    });
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("clientIp", "127.0.0.1");
      await next();
    });
    app.get("/issue", async (c) => {
      await svc.issue(c, uid);
      return c.text("ok");
    });
    app.get("/logout", async (c) => {
      await svc.revoke(c);
      return c.text("bye");
    });

    const token = cookieToken(await app.request("/issue")) as string;
    await app.request("/logout", { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });

    expect(events.map((e) => e.action)).toEqual(["session_create", "session_revoke"]);
    expect(events.every((e) => e.actorId === uid)).toBe(true);
  });

  it("scopes the cookie to the base domain in subdomain mode, host-only in path mode", async () => {
    client = await makeTestDb("sqlite");
    const uid = await seedUser(client);

    const sub = await buildApp(subConfig, client).request(`/issue/${uid}`);
    expect(setCookies(sub).find((c) => c.startsWith(SESSION_COOKIE))).toMatch(
      /Domain=\.canvases\.example\.com/i,
    );

    const path = await buildApp(pathConfig, client).request(`/issue/${uid}`);
    expect(setCookies(path).find((c) => c.startsWith(SESSION_COOKIE))).not.toMatch(/Domain=/i);
  });
});

describe("sessionBackedStrategy", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("resolves identity from a live session cookie, null otherwise", async () => {
    client = await makeTestDb("sqlite");
    const uid = await seedUser(client);
    const app = buildApp(pathConfig, client);
    const token = cookieToken(await app.request(`/issue/${uid}`)) as string;

    const withCookie = await app.request("/identity", {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect((await jsonOf<{ id: { email: string } }>(withCookie)).id.email).toBe("user@example.com");

    const without = await app.request("/identity");
    expect((await jsonOf<{ id: unknown }>(without)).id).toBeNull();
  });
});

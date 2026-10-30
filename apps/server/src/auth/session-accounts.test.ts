import { loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { sessionsRepository } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { ACCOUNTS_COOKIE, MAX_OTHER_ACCOUNTS, SESSION_COOKIE, sessionService } from "./session.js";

const pathConfig = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
const subConfig = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_URL_MODE: "subdomain",
  CANVAS_DROP_BASE_URL: "https://canvases.example.com",
});

/** A minimal browser cookie store: applies Set-Cookie, sends Cookie. */
class Browser {
  readonly jar = new Map<string, string>();
  apply(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const eq = (pair ?? "").indexOf("=");
      const name = (pair ?? "").slice(0, eq).trim();
      const value = decodeURIComponent((pair ?? "").slice(eq + 1).trim());
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
  header() {
    return [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  }
}

/** The session tokens in a browser's account jar (the cookie leads with its MAC). */
function jarTokens(browser: Browser): string[] {
  return (browser.jar.get(ACCOUNTS_COOKIE) ?? "").split(".").slice(1);
}

async function seedUsers(client: DbClient, n: number): Promise<string[]> {
  const users = usersRepository(client);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = await users.upsert({
      providerSub: `oidc:s${i}`,
      email: `user${i}@example.com`,
      name: `User ${i}`,
      isAdmin: false,
    });
    ids.push(u.id);
  }
  return ids;
}

function buildApp(
  client: DbClient,
  config = pathConfig,
  isEligible?: (userId: string) => Promise<boolean>,
) {
  const events: Array<{ action: string; actorId?: string | null }> = [];
  const svc = sessionService(
    config,
    sessionsRepository(client),
    { recordAudit: (e) => events.push(e) },
    { isEligible },
  );
  const app = new Hono<AppEnv>();
  app.get("/issue/:uid", async (c) => {
    await svc.issue(c, c.req.param("uid"));
    return c.text("ok");
  });
  app.get("/whoami", async (c) => c.json({ uid: await svc.resolveUserId(c) }));
  app.get("/others", async (c) => c.json((await svc.otherAccounts(c)).map((a) => a.userId)));
  app.get("/switch/:uid", async (c) => c.json({ ok: await svc.switchTo(c, c.req.param("uid")) }));
  app.get("/revoke", async (c) => c.json(await svc.revoke(c)));
  app.get("/revoke-all", async (c) => {
    await svc.revokeAll(c);
    return c.text("bye");
  });
  return { app, events };
}

async function call<T>(app: Hono<AppEnv>, browser: Browser, path: string): Promise<T> {
  const res = browser.apply(await app.request(path, { headers: { Cookie: browser.header() } }));
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

describe.each(DIALECTS)("multi-account sessions [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("signing in a second account keeps the first one in the account jar", async () => {
    client = await makeTestDb(dialect);
    const [a, b] = await seedUsers(client, 2);
    const { app } = buildApp(client);
    const browser = new Browser();
    await call(app, browser, `/issue/${a}`);
    await call(app, browser, `/issue/${b}`);

    expect((await call<{ uid: string }>(app, browser, "/whoami")).uid).toBe(b);
    expect(await call<string[]>(app, browser, "/others")).toEqual([a]);
    // The kept account is still a live session, not just a remembered id.
    const [jarToken] = jarTokens(browser);
    expect((await sessionsRepository(client).findLiveByToken(jarToken as string))?.userId).toBe(a);
  });

  it("switches the active account and remembers the previous one", async () => {
    client = await makeTestDb(dialect);
    const [a, b, c] = await seedUsers(client, 3);
    const { app, events } = buildApp(client);
    const browser = new Browser();
    for (const id of [a, b, c]) await call(app, browser, `/issue/${id}`);

    expect((await call<{ ok: boolean }>(app, browser, `/switch/${a}`)).ok).toBe(true);
    expect((await call<{ uid: string }>(app, browser, "/whoami")).uid).toBe(a);
    // Most recently used first: c was active just now, then b.
    expect(await call<string[]>(app, browser, "/others")).toEqual([c, b]);
    expect(events.filter((e) => e.action === "session_switch")).toEqual([
      expect.objectContaining({ actorId: a }),
    ]);
  });

  it("refuses to switch to an account this browser holds no session for", async () => {
    client = await makeTestDb(dialect);
    const [a, b, stranger] = await seedUsers(client, 3);
    const { app } = buildApp(client);
    const browser = new Browser();
    await call(app, browser, `/issue/${a}`);
    await call(app, browser, `/issue/${b}`);

    expect((await call<{ ok: boolean }>(app, browser, `/switch/${stranger}`)).ok).toBe(false);
    expect((await call<{ ok: boolean }>(app, browser, `/switch/${b}`)).ok).toBe(false);
    expect((await call<{ uid: string }>(app, browser, "/whoami")).uid).toBe(b);
  });

  it("ignores forged, malformed and revoked jar entries", async () => {
    client = await makeTestDb(dialect);
    const [a, b] = await seedUsers(client, 2);
    const { app } = buildApp(client);
    const browser = new Browser();
    await call(app, browser, `/issue/${a}`);
    await call(app, browser, `/issue/${b}`);
    const [realA] = jarTokens(browser);
    const mac = (browser.jar.get(ACCOUNTS_COOKIE) as string).split(".")[0];
    // A bare token list (no MAC), a bad MAC, and junk entries are all ignored.
    for (const forged of [realA, `${"x".repeat(43)}.${realA}`, `${mac}.not a token.${realA}`]) {
      browser.jar.set(ACCOUNTS_COOKIE, forged as string);
      expect(await call<string[]>(app, browser, "/others")).toEqual([]);
    }
    // The genuine jar stops offering an account once its session is revoked.
    browser.jar.set(ACCOUNTS_COOKIE, `${mac}.${realA}`);
    expect(await call<string[]>(app, browser, "/others")).toEqual([a]);
    await sessionsRepository(client).revokeByToken(realA as string);
    expect(await call<string[]>(app, browser, "/others")).toEqual([]);
    expect((await call<{ ok: boolean }>(app, browser, `/switch/${a}`)).ok).toBe(false);
  });

  it("ignores a jar planted from another browser (bound to that browser's active session)", async () => {
    client = await makeTestDb(dialect);
    const [victim, attacker, attackerAlt] = await seedUsers(client, 3);
    const { app } = buildApp(client);
    // The attacker builds a perfectly valid jar in their own browser...
    const theirs = new Browser();
    await call(app, theirs, `/issue/${attacker}`);
    await call(app, theirs, `/issue/${attackerAlt}`);
    // ...and a canvas script plants it on the victim's browser.
    const browser = new Browser();
    await call(app, browser, `/issue/${victim}`);
    browser.jar.set(ACCOUNTS_COOKIE, theirs.jar.get(ACCOUNTS_COOKIE) as string);

    expect(await call<string[]>(app, browser, "/others")).toEqual([]);
    expect((await call<{ ok: boolean }>(app, browser, `/switch/${attacker}`)).ok).toBe(false);
    // Nor does it take over when the victim signs out of their account.
    expect(await call<{ remaining: boolean }>(app, browser, "/revoke")).toEqual({
      remaining: false,
    });
    expect((await call<{ uid: string | null }>(app, browser, "/whoami")).uid).toBeNull();
  });

  it("never signs in from a jar alone, without an active session cookie", async () => {
    client = await makeTestDb(dialect);
    const [a, b] = await seedUsers(client, 2);
    const { app } = buildApp(client);
    const browser = new Browser();
    await call(app, browser, `/issue/${a}`);
    await call(app, browser, `/issue/${b}`);
    browser.jar.delete(SESSION_COOKIE);
    expect((await call<{ uid: string | null }>(app, browser, "/whoami")).uid).toBeNull();
  });

  it("never lists, switches to or promotes an ineligible (e.g. blocked) account", async () => {
    client = await makeTestDb(dialect);
    const [a, blocked, c] = await seedUsers(client, 3);
    const { app } = buildApp(client, pathConfig, async (id) => id !== blocked);
    const browser = new Browser();
    for (const id of [a, blocked, c]) await call(app, browser, `/issue/${id}`);
    // c active; jar = [blocked, a].
    expect(await call<string[]>(app, browser, "/others")).toEqual([a]);
    expect((await call<{ ok: boolean }>(app, browser, `/switch/${blocked}`)).ok).toBe(false);
    // Signing out of c skips the blocked account and hands over to a.
    expect(await call<{ remaining: boolean }>(app, browser, "/revoke")).toEqual({
      remaining: true,
    });
    expect((await call<{ uid: string }>(app, browser, "/whoami")).uid).toBe(a);
  });

  it("signing in again as a held account replaces its old session instead of duplicating it", async () => {
    client = await makeTestDb(dialect);
    const [a, b] = await seedUsers(client, 2);
    const { app } = buildApp(client);
    const browser = new Browser();
    await call(app, browser, `/issue/${a}`);
    await call(app, browser, `/issue/${b}`);
    const [oldA] = jarTokens(browser);
    await call(app, browser, `/issue/${a}`);

    expect((await call<{ uid: string }>(app, browser, "/whoami")).uid).toBe(a);
    expect(await call<string[]>(app, browser, "/others")).toEqual([b]);
    expect(await sessionsRepository(client).findLiveByToken(oldA as string)).toBeNull();
  });

  it("re-signing in as the active account retires the previous session", async () => {
    client = await makeTestDb(dialect);
    const [a] = await seedUsers(client, 1);
    const { app } = buildApp(client);
    const browser = new Browser();
    await call(app, browser, `/issue/${a}`);
    const first = browser.jar.get(SESSION_COOKIE) as string;
    await call(app, browser, `/issue/${a}`);

    expect(await sessionsRepository(client).findLiveByToken(first)).toBeNull();
    expect(await call<string[]>(app, browser, "/others")).toEqual([]);
  });

  it(`caps a browser at ${MAX_OTHER_ACCOUNTS + 1} accounts, revoking the least recently used`, async () => {
    client = await makeTestDb(dialect);
    const ids = await seedUsers(client, MAX_OTHER_ACCOUNTS + 2);
    const { app } = buildApp(client);
    const browser = new Browser();
    await call(app, browser, `/issue/${ids[0]}`);
    const oldest = browser.jar.get(SESSION_COOKIE) as string;
    for (const id of ids.slice(1)) await call(app, browser, `/issue/${id}`);

    const others = await call<string[]>(app, browser, "/others");
    expect(others).toHaveLength(MAX_OTHER_ACCOUNTS);
    expect(others).not.toContain(ids[0]);
    // Evicted means signed out server-side, not merely forgotten by the cookie.
    expect(await sessionsRepository(client).findLiveByToken(oldest)).toBeNull();
  });

  it("signing out of the current account hands over to the next one", async () => {
    client = await makeTestDb(dialect);
    const [a, b] = await seedUsers(client, 2);
    const { app } = buildApp(client);
    const browser = new Browser();
    await call(app, browser, `/issue/${a}`);
    await call(app, browser, `/issue/${b}`);
    const tokenB = browser.jar.get(SESSION_COOKIE) as string;

    expect(await call<{ remaining: boolean }>(app, browser, "/revoke")).toEqual({
      remaining: true,
    });
    expect((await call<{ uid: string }>(app, browser, "/whoami")).uid).toBe(a);
    expect(await sessionsRepository(client).findLiveByToken(tokenB)).toBeNull();
    expect(browser.jar.has(ACCOUNTS_COOKIE)).toBe(false);

    expect(await call<{ remaining: boolean }>(app, browser, "/revoke")).toEqual({
      remaining: false,
    });
    expect((await call<{ uid: string | null }>(app, browser, "/whoami")).uid).toBeNull();
    expect(browser.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("sign out of all revokes every held session", async () => {
    client = await makeTestDb(dialect);
    const [a, b] = await seedUsers(client, 2);
    const { app, events } = buildApp(client);
    const browser = new Browser();
    await call(app, browser, `/issue/${a}`);
    await call(app, browser, `/issue/${b}`);
    const tokens = [browser.jar.get(SESSION_COOKIE), ...jarTokens(browser)];

    await call(app, browser, "/revoke-all");
    for (const t of tokens)
      expect(await sessionsRepository(client).findLiveByToken(t as string)).toBeNull();
    expect(browser.jar.size).toBe(0);
    expect(
      events
        .filter((e) => e.action === "session_revoke")
        .map((e) => e.actorId)
        .sort(),
    ).toEqual([a, b].sort());
  });

  it("promotes a held account when the active session ended elsewhere", async () => {
    client = await makeTestDb(dialect);
    const [a, b] = await seedUsers(client, 2);
    const { app } = buildApp(client);
    const browser = new Browser();
    await call(app, browser, `/issue/${a}`);
    await call(app, browser, `/issue/${b}`);
    await sessionsRepository(client).revokeAllForUser(b as string);

    expect((await call<{ uid: string }>(app, browser, "/whoami")).uid).toBe(a);
    expect(await call<string[]>(app, browser, "/others")).toEqual([]);
  });

  it("scopes the jar cookie exactly like the session cookie (HttpOnly, base domain)", async () => {
    client = await makeTestDb(dialect);
    const [a, b] = await seedUsers(client, 2);
    const { app } = buildApp(client, subConfig);
    const browser = new Browser();
    await call(app, browser, `/issue/${a}`);
    const res = await app.request(`/issue/${b}`, { headers: { Cookie: browser.header() } });
    const raw = res.headers.getSetCookie().find((c) => c.startsWith(ACCOUNTS_COOKIE));
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Domain=\.canvases\.example\.com/i);
  });
});

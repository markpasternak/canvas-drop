import { loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { guestRepository } from "../db/repositories/guest.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { AppEnv, Principal } from "../http/types.js";
import { guestService } from "./guest.js";

const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_URL_MODE: "path",
  CANVAS_DROP_BASE_URL: "http://localhost:3000",
});

async function seedCanvas(client: DbClient): Promise<string> {
  const owner = await usersRepository(client).upsert({
    providerSub: "owner",
    email: "owner@example.com",
    name: "Owner",
    isAdmin: false,
  });
  const cv = await canvasesRepository(client).create({
    ownerId: owner.id,
    slug: "s",
    apiKeyHash: "h",
  });
  return cv.id;
}

/** App exposing consume + resolve so cookies round-trip like in production. */
function appFor(client: DbClient) {
  const svc = guestService(config, guestRepository(client));
  const app = new Hono<AppEnv>();
  app.get("/consume", async (c) => {
    const p = await svc.consumeMagicLink(c, c.req.query("token") ?? "");
    return p ? c.json({ ok: true, email: (p as { email: string }).email }) : c.json({ ok: false });
  });
  app.get("/me", async (c) => {
    const p = await svc.resolveGuest(c);
    return p ? c.json(p as Principal) : c.json({ guest: false });
  });
  return { app, svc };
}

/** Pull the guest cookie value out of a Set-Cookie header for the next request. */
function cookieFrom(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0] ?? "";
}

describe.each(DIALECTS)("guestService [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("consume establishes a session; resolve returns the scoped guest principal", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const { app, svc } = appFor(client);
    const { token } = await svc.createInvite(canvasId, "partner@acme.com");

    const consumed = await app.request(`/consume?token=${token}`);
    expect(await consumed.json()).toMatchObject({ ok: true, email: "partner@acme.com" });

    const me = await app.request("/me", { headers: { cookie: cookieFrom(consumed) } });
    const principal = (await me.json()) as Extract<Principal, { kind: "guest" }>;
    expect(principal.kind).toBe("guest");
    expect(principal.canvasId).toBe(canvasId);
    expect(principal.id).toBe(`guest:${principal.inviteId}`);
  });

  it("magic link is single-use — a second consume fails", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const { app, svc } = appFor(client);
    const { token } = await svc.createInvite(canvasId, "p@acme.com");
    expect(await (await app.request(`/consume?token=${token}`)).json()).toMatchObject({ ok: true });
    expect(await (await app.request(`/consume?token=${token}`)).json()).toEqual({ ok: false });
  });

  it("an expired invite does not establish a session", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const { app, svc } = appFor(client);
    const { token } = await svc.createInvite(canvasId, "p@acme.com", Date.now() - 1000);
    expect(await (await app.request(`/consume?token=${token}`)).json()).toEqual({ ok: false });
  });

  it("revoking the invite kills the live session on the next resolve (R12)", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const repo = guestRepository(client);
    const { app, svc } = appFor(client);
    const { token } = await svc.createInvite(canvasId, "p@acme.com");
    const consumed = await app.request(`/consume?token=${token}`);
    const cookie = cookieFrom(consumed);
    expect(await (await app.request("/me", { headers: { cookie } })).json()).toMatchObject({
      kind: "guest",
    });

    await repo.revokeInvite(canvasId, "p@acme.com");
    expect(await (await app.request("/me", { headers: { cookie } })).json()).toEqual({
      guest: false,
    });
  });

  it("re-inviting the same email mints a fresh token and invalidates the old one", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const { app, svc } = appFor(client);
    const first = await svc.createInvite(canvasId, "p@acme.com");
    const second = await svc.createInvite(canvasId, "p@acme.com");
    expect(second.token).not.toBe(first.token);
    // Old token no longer consumes; the new one does.
    expect(await (await app.request(`/consume?token=${first.token}`)).json()).toEqual({
      ok: false,
    });
    expect(await (await app.request(`/consume?token=${second.token}`)).json()).toMatchObject({
      ok: true,
    });
  });

  it("stores only the token hash, never the plaintext", async () => {
    client = await makeTestDb(dialect);
    const canvasId = await seedCanvas(client);
    const repo = guestRepository(client);
    const { svc } = appFor(client);
    const { token, invite } = await svc.createInvite(canvasId, "p@acme.com");
    const stored = await repo.findInviteById(invite.id);
    expect(stored?.tokenHash).toBeTruthy();
    expect(stored?.tokenHash).not.toBe(token);
  });
});

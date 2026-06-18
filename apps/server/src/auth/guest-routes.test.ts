import { loadConfig } from "@canvas-drop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditLog, RecordAuditInput } from "../audit/audit-log.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { guestRepository } from "../db/repositories/guest.js";
import { hashToken } from "../db/repositories/sessions.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
import type { AppEnv } from "../http/types.js";
import { guestService } from "./guest.js";
import { guestRoutes } from "./guest-routes.js";

const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "dev",
  CANVAS_DROP_URL_MODE: "path",
  CANVAS_DROP_BASE_URL: "http://localhost:3000",
});

async function seed(client: DbClient): Promise<{ canvasId: string; token: string }> {
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
  // Publish so the consume redirect targets an active canvas.
  await canvasesRepository(client).setAccess(cv.id, "specific_people");
  const svc = guestService(config, guestRepository(client));
  const { token } = await svc.createInvite(cv.id, "p@acme.com");
  return { canvasId: cv.id, token };
}

function appFor(client: DbClient) {
  return guestRoutes({
    config,
    guests: guestService(config, guestRepository(client)),
    canvases: canvasesRepository(client),
  });
}

describe.each(DIALECTS)("guestRoutes [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("GET renders a landing page and does NOT consume the token", async () => {
    client = await makeTestDb(dialect);
    const { token } = await seed(client);
    const app = appFor(client);
    const res = await app.request(`/guest/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // The token is still pending: a real consume still works afterward.
    const post = await app.request(`/guest/${token}`, { method: "POST" });
    expect(post.status).toBe(302);
  });

  it("rejects a cross-site POST (login-CSRF / session fixation guard)", async () => {
    client = await makeTestDb(dialect);
    const { token } = await seed(client);
    const app = appFor(client);
    const res = await app.request(`/guest/${token}`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
    // The token was NOT burned — a legitimate same-origin consume still succeeds.
    const ok = await app.request(`/guest/${token}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(ok.status).toBe(302);
  });

  it("same-origin POST consumes the token and redirects to the canvas", async () => {
    client = await makeTestDb(dialect);
    const { token } = await seed(client);
    const app = appFor(client);
    const res = await app.request(`/guest/${token}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("__canvasdrop_guest");
  });

  it("records a guest_login audit event carrying the actor id and client IP", async () => {
    // Regression (server-auth-2): the guest_login audit row must include the client
    // IP (forensic attribution for a leaked magic link) like every other auth event.
    client = await makeTestDb(dialect);
    const { canvasId, token } = await seed(client);
    const events: RecordAuditInput[] = [];
    const audit: AuditLog = {
      recordAudit: (e) => events.push(e),
      record: () => {},
      flush: async () => {},
    };
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("clientIp", "203.0.113.7");
      await next();
    });
    app.route(
      "/",
      guestRoutes({
        config,
        guests: guestService(config, guestRepository(client)),
        canvases: canvasesRepository(client),
        audit,
      }),
    );

    const res = await app.request(`/guest/${token}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(302);
    const login = events.find((e) => e.action === "guest_login");
    expect(login).toBeDefined();
    expect(login?.ip).toBe("203.0.113.7");
    expect(login?.targetId).toBe(canvasId);
    expect(login?.actorId).toBeTruthy(); // guest:<inviteId>
  });

  it("an archived canvas yields 410 WITHOUT burning the single-use invite", async () => {
    // Regression (server-auth-1): the canvas-status check must run BEFORE the token
    // is consumed, so archiving an invited canvas mid-flight doesn't dead-end the
    // guest by permanently burning their only link.
    client = await makeTestDb(dialect);
    const { canvasId, token } = await seed(client);
    await canvasesRepository(client).archive(canvasId);
    const app = appFor(client);

    const res = await app.request(`/guest/${token}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(410);
    expect(res.headers.get("set-cookie")).toBeNull(); // no session minted

    // The invite is still pending — un-archive and the same link consumes cleanly.
    const invite = await guestRepository(client).findInviteByTokenHash(hashToken(token));
    expect(invite?.state).toBe("pending");
    await canvasesRepository(client).unarchive(canvasId);
    const ok = await app.request(`/guest/${token}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(ok.status).toBe(302);
  });
});

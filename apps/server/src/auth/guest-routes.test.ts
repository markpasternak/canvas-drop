import { loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { guestRepository } from "../db/repositories/guest.js";
import { usersRepository } from "../db/repositories/users.js";
import { DIALECTS, makeTestDb } from "../db/testing.js";
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
});

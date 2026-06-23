import { loadConfig } from "@canvas-drop/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { guestRepository } from "../db/repositories/guest.js";
import { hashToken } from "../db/repositories/sessions.js";
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

function appFor() {
  return guestRoutes({ config });
}

describe.each(DIALECTS)("guestRoutes [%s]", (dialect) => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("GET returns a no-store invalid-link page and does not consume the token", async () => {
    client = await makeTestDb(dialect);
    const { token } = await seed(client);
    const app = appFor();
    const res = await app.request(`/guest/${token}`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(410);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/html");
    // Token still exists as legacy data; the route just no longer consumes it.
    const invite = await guestRepository(client).findInviteByTokenHash(hashToken(token));
    expect(invite?.state).toBe("pending");
  });

  it("POST returns invalid-link and never sets a guest cookie", async () => {
    client = await makeTestDb(dialect);
    const { token } = await seed(client);
    const app = appFor();
    const res = await app.request(`/guest/${token}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(410);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("retired POST does not consume a token even when the target canvas is archived", async () => {
    client = await makeTestDb(dialect);
    const { canvasId, token } = await seed(client);
    await canvasesRepository(client).archive(canvasId);
    const app = appFor();

    const res = await app.request(`/guest/${token}`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(410);
    expect(res.headers.get("set-cookie")).toBeNull(); // no session minted

    const invite = await guestRepository(client).findInviteByTokenHash(hashToken(token));
    expect(invite?.state).toBe("pending");
  });
});

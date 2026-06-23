import { loadConfig } from "@canvas-drop/shared";
import type { AccessRung } from "@canvas-drop/shared/db";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { afterEach, describe, expect, it } from "vitest";
import { requestPrincipal } from "../canvas/authorization.js";
import type { DbClient } from "../db/factory.js";
import { canvasesRepository } from "../db/repositories/canvases.js";
import { usersRepository } from "../db/repositories/users.js";
import { makeTestDb } from "../db/testing.js";
import { socialPreview } from "../http/social-preview.js";
import type { AppEnv } from "../http/types.js";
import { onlyWhenNoPrincipal, publicCanvasResolver } from "./public-canvas-resolver.js";

// oidc + path mode: socialPreview is active, and `/c/<slug>` resolves to the
// `canvas` role (so we don't need wildcard hosts in the test).
const config = loadConfig({
  CANVAS_DROP_AUTH_MODE: "oidc",
  CANVAS_DROP_URL_MODE: "path",
  CANVAS_DROP_ALLOW_MULTI_USER_PATH_MODE: "true",
  CANVAS_DROP_BASE_URL: "http://localhost:3000",
  CANVAS_DROP_SESSION_SECRET: "test-session-secret-of-at-least-32-chars!!",
  CANVAS_DROP_ALLOWED_EMAIL_DOMAINS: "example.com",
  CANVAS_DROP_OIDC_ISSUER: "https://idp.example.com",
  CANVAS_DROP_OIDC_CLIENT_ID: "id",
  CANVAS_DROP_OIDC_CLIENT_SECRET: "secret",
});

async function seedCanvas(
  client: DbClient,
  access: AccessRung,
  opts: {
    passwordHash?: string;
    sharedExpiresAt?: number;
    canPublishPublic?: boolean;
  } = {},
): Promise<string> {
  const owner = await usersRepository(client).upsert({
    providerSub: "owner",
    email: "owner@example.com",
    name: "Owner",
    isAdmin: false,
  });
  if (opts.canPublishPublic === false) {
    await usersRepository(client).setPublishPublic(owner.id, false);
  }
  const repo = canvasesRepository(client);
  const cv = await repo.create({
    ownerId: owner.id,
    slug: "demo",
    apiKeyHash: "h",
    passwordHash: opts.passwordHash,
  });
  if (access !== "private") await repo.setAccess(cv.id, access);
  if (opts.sharedExpiresAt !== undefined) {
    await repo.updateSettings(cv.id, { sharedExpiresAt: opts.sharedExpiresAt });
  }
  return cv.id;
}

/** Build the carve-out chain over a fake gateway, ending in a probe handler. */
function appFor(client: DbClient, opts: { publicLinksEnabled?: boolean } = {}) {
  const canvases = canvasesRepository(client);
  // Fake org gateway: marks that it ran and sets a member user.
  const fakeGateway = createMiddleware<AppEnv>(async (c, next) => {
    c.header("x-gateway", "ran");
    c.set("user", { id: "member-1", isAdmin: false } as never);
    await next();
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("clientIp", "1.2.3.4");
    await next();
  });
  app.use(
    "*",
    publicCanvasResolver({
      config,
      canvases,
      publicLinksEnabled: () => Promise.resolve(opts.publicLinksEnabled ?? true),
    }),
  );
  app.use("*", socialPreview(config));
  app.use("*", onlyWhenNoPrincipal(fakeGateway));
  app.all("*", (c) => {
    const p = requestPrincipal(c);
    return c.json({ kind: p.kind, gateway: c.res.headers.get("x-gateway") ?? "skipped" });
  });
  return { app, canvases };
}

const JSON_HDR = { accept: "application/json" };

describe("publicCanvasResolver — public-link carve-out (sqlite)", () => {
  let client: DbClient;
  afterEach(async () => {
    await client?.close();
  });

  it("anonymous request to a PRIVATE canvas sets no principal — gateway runs", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, "private");
    const { app } = appFor(client);
    const res = await app.request("/c/demo", { headers: JSON_HDR });
    const body = (await res.json()) as { kind: string; gateway: string };
    expect(body.kind).toBe("member"); // requestPrincipal fell back to the gateway user
    expect(body.gateway).toBe("ran");
  });

  it("anonymous request to a WHOLE_ORG canvas still goes to the gateway (not anonymous)", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, "whole_org");
    const { app } = appFor(client);
    const body = (await (await app.request("/c/demo", { headers: JSON_HDR })).json()) as {
      gateway: string;
    };
    expect(body.gateway).toBe("ran");
  });

  it("anonymous request to a PUBLIC_LINK canvas sets the anonymous principal, skips the gateway", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, "public_link");
    const { app } = appFor(client);
    const body = (await (await app.request("/c/demo", { headers: JSON_HDR })).json()) as {
      kind: string;
      gateway: string;
    };
    expect(body.kind).toBe("anonymous");
    expect(body.gateway).toBe("skipped");
  });

  it("effective public-link gates fall through to the gateway", async () => {
    for (const [name, seedOpts, appOpts] of [
      ["passworded", { passwordHash: "hash" }, {}],
      ["expired", { sharedExpiresAt: Date.now() - 1_000 }, {}],
      ["owner revoked", { canPublishPublic: false }, {}],
      ["globally disabled", {}, { publicLinksEnabled: false }],
    ] as const) {
      const caseClient = await makeTestDb("sqlite");
      try {
        await seedCanvas(caseClient, "public_link", seedOpts);
        const { app } = appFor(caseClient, appOpts);
        const body = (await (await app.request("/c/demo", { headers: JSON_HDR })).json()) as {
          kind: string;
          gateway: string;
        };
        expect(body, name).toMatchObject({ kind: "member", gateway: "ran" });
      } finally {
        await caseClient.close();
      }
    }
  });

  it("a forged/invalid guest cookie sets no principal — the gateway runs", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, "whole_org");
    const { app } = appFor(client);
    const body = (await (
      await app.request("/c/demo", {
        headers: { ...JSON_HDR, cookie: "__canvasdrop_guest=forged" },
      })
    ).json()) as { gateway: string };
    expect(body.gateway).toBe("ran");
  });

  it("a legacy guest cookie is ignored even when it used to be valid — gateway runs", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, "specific_people");
    const { app } = appFor(client);
    const body = (await (
      await app.request("/c/demo", {
        headers: { ...JSON_HDR, cookie: "__canvasdrop_guest=legacy" },
      })
    ).json()) as {
      kind: string;
      gateway: string;
    };
    expect(body.kind).toBe("member");
    expect(body.gateway).toBe("ran");
  });

  it("a legacy guest cookie on a DASHBOARD/management request is ignored — gateway runs", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, "specific_people");
    const { app } = appFor(client);
    // /api/... is the management surface, not a canvas surface.
    const body = (await (
      await app.request("/api/canvases", {
        headers: { ...JSON_HDR, cookie: "__canvasdrop_guest=legacy" },
      })
    ).json()) as { gateway: string };
    expect(body.gateway).toBe("ran");
  });

  it("signed-out HTML GET to a PUBLIC_LINK canvas is served, not bounced to login (oidc)", async () => {
    client = await makeTestDb("sqlite");
    await seedCanvas(client, "public_link");
    const { app } = appFor(client);
    // An HTML navigation with no session: socialPreview would normally intercept,
    // but the resolved anonymous principal makes it step aside.
    const res = await app.request("/c/demo", { headers: { accept: "text/html" } });
    const body = (await res.json()) as { kind: string };
    expect(res.status).toBe(200);
    expect(body.kind).toBe("anonymous");
  });
});
